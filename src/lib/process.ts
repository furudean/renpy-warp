import * as vscode from 'vscode'
import child_process from 'node:child_process'
import { WebSocket } from 'ws'
import { get_logger } from './logger'
import pidtree from 'pidtree'
import { windowManager } from 'node-window-manager'

const logger = get_logger()

let output_channel: vscode.OutputChannel | undefined

type MaybePromise<T> = T | Promise<T>

export interface SocketMessage {
	type: string
	[key: string]: any
}

export async function focus_window(pid: number) {
	// windows creates subprocesses for each window, so we need to find
	// the subprocess associated with the parent process we created
	const pids = [pid, ...(await pidtree(pid))]
	const matching_windows = windowManager
		.getWindows()
		.filter((win) => pids.includes(win.processId))

	logger.debug('matching windows:', matching_windows)

	if (!matching_windows) {
		logger.warn('no matching window found', windowManager.getWindows())
		return
	}

	const has_accessibility = windowManager.requestAccessibility()

	if (has_accessibility) {
		matching_windows.forEach((win) => {
			// bring all windows to top. windows creates many
			// subprocesses and figuring out the right one is not straightforward
			win.bringToTop()
		})
	} else {
		vscode.window.showInformationMessage(
			"Accessibility permissions have been requested. These are used to focus the Ren'Py window. You may need to restart Visual Studio Code for this to take effect.",
			'OK'
		)
	}
}

export class RenpyProcess {
	cmd: string
	message_handler: (
		process: RenpyProcess,
		data: SocketMessage
	) => MaybePromise<void>
	game_root: string
	socket_port: number | undefined
	process: child_process.ChildProcess
	socket?: WebSocket = undefined
	dead: boolean = false

	constructor({
		cmd,
		message_handler,
		game_root,
		socket_port,
		context,
	}: {
		cmd: string
		message_handler: typeof RenpyProcess.prototype.message_handler
		game_root: string
		socket_port: number | undefined
		context: vscode.ExtensionContext
	}) {
		this.cmd = cmd
		this.message_handler = message_handler
		this.game_root = game_root
		this.socket_port = socket_port

		logger.info('executing subshell:', cmd)
		this.process = child_process.exec(cmd)

		if (!output_channel) {
			output_channel = vscode.window.createOutputChannel(
				`Ren'Py Launch and Sync - Process Output`
			)
			context.subscriptions.push(output_channel)
		}

		output_channel.appendLine(`process ${this.process.pid} started`)

		this.process.stdout!.on('data', (data: string) =>
			output_channel!.appendLine(
				`[${this.process.pid} out] ${data.trim()}`
			)
		)
		this.process.stderr!.on('data', (data) =>
			output_channel!.appendLine(
				`[${this.process.pid} err] ${data.trim()}`
			)
		)
		this.process.on('exit', (code) => {
			this.dead = true
			logger.info(`process ${this.process.pid} exited with code ${code}`)
			output_channel!.appendLine(
				`process ${this.process.pid} exited with code ${code}`
			)
		})

		logger.info('created process', this.process.pid)
	}

	async wait_for_socket_alive(timeout_ms: number): Promise<void> {
		if (this.socket) return

		logger.info('waiting for socket connection from renpy window...')

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				clearInterval(interval)
				reject(new Error('timed out waiting for socket'))
			}, timeout_ms)

			const interval = setInterval(() => {
				if (this.socket || this.dead) {
					clearTimeout(timeout)
					clearInterval(interval)

					this.socket
						? resolve()
						: reject(
								new Error(
									'process died before socket connected'
								)
						  )
				}
			}, 50)
		})
	}

	async wait_for_socket_death(timeout_ms: number): Promise<void> {
		if (!this.socket) return

		logger.info('waiting for socket to close...')

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				clearInterval(interval)
				reject(new Error('timed out waiting for socket to close'))
			}, timeout_ms)

			const interval = setInterval(() => {
				if (!this.socket || this.dead) {
					clearTimeout(timeout)
					clearInterval(interval)

					this.socket
						? reject(new Error('process died before socket closed'))
						: resolve()
				}
			}, 50)
		})
	}

	kill() {
		this.process.kill()
	}

	async ipc(message: SocketMessage): Promise<void> {
		if (!this.socket || this.socket?.readyState !== WebSocket.OPEN) {
			throw new Error('no socket connection')
		}

		return new Promise((resolve, reject) => {
			const serialized = JSON.stringify(message)

			const timeout = setTimeout(() => {
				reject(new Error('ipc timed out'))
			}, 1000)
			this.socket!.send(serialized, (err) => {
				logger.debug('websocket >', serialized)

				clearTimeout(timeout)
				if (err) {
					reject(err)
				} else {
					resolve()
				}
			})
		})
	}

	/**
	 * @param line
	 * 1-indexed line number
	 */
	async warp_to_line(file: string, line: number) {
		return this.ipc({
			type: 'warp_to_line',
			file,
			line,
		})
	}

	/**
	 * await this promise to ensure the process has reloaded and is ready to
	 * receive IPC
	 */
	async reload() {
		await this.ipc({
			type: 'reload',
		})

		await this.wait_for_socket_death(5000)
		await this.wait_for_socket_alive(10_000)
	}
}

export class ProcessManager {
	private processes = new Map<number, RenpyProcess>()

	/** Runs on process exit, after process has been removed */
	private exit_handler: (process: RenpyProcess) => MaybePromise<void>

	constructor({
		exit_handler,
	}: {
		exit_handler: typeof ProcessManager.prototype.exit_handler
	}) {
		this.exit_handler = exit_handler
	}

	[Symbol.iterator]() {
		return this.processes.values()
	}

	/** @param {RenpyProcess} process */
	async add(process: RenpyProcess) {
		if (!process.process.pid) throw new Error('no pid in process')

		this.processes.set(process.process.pid, process)

		process.process.on('exit', (code) => {
			if (!process.process.pid) throw new Error('no pid in process')

			this.processes.delete(process.process.pid)

			if (code) {
				vscode.window
					.showErrorMessage(
						"Ren'Py process exited with errors",
						'OK',
						'Logs'
					)
					.then((selected) => {
						if (selected === 'Logs') output_channel!.show()
					})
			}

			this.exit_handler(process)
		})
	}

	get(pid: number): RenpyProcess | undefined {
		return this.processes.get(pid)
	}

	at(index: number): RenpyProcess | undefined {
		return Array.from(this.processes.values()).at(index)
	}

	async find_tracked(candidate: number): Promise<RenpyProcess | undefined> {
		if (this.processes.has(candidate)) return this.processes.get(candidate)

		for (const pid of this.pids) {
			// the process might be a child of the process we created
			const child_pids = await pidtree(pid)
			logger.debug(`child pids for ${pid}: ${JSON.stringify(child_pids)}`)

			if (child_pids.includes(candidate)) {
				const rpp = this.get(pid)

				if (rpp) return rpp
			}
		}
		return
	}

	kill_all() {
		for (const { process } of this) {
			process.kill(9) // SIGKILL, bypasses "are you sure" dialog
		}
	}

	dispose() {
		this.kill_all()
	}

	get length() {
		return this.processes.size
	}

	get pids(): number[] {
		return [...this.processes.keys()]
	}
}
