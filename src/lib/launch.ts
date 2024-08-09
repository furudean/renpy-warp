import * as vscode from 'vscode'
import path from 'upath'
import { sh } from 'puka'
import child_process from 'child_process'

import { ProcessManager, ManagedProcess, AnyProcess } from './process'
import { FollowCursor, sync_editor_with_renpy } from './follow_cursor'
import { get_config, show_file } from './config'
import { get_logger } from './logger'
import {
	get_editor_path,
	get_executable,
	add_env,
	find_project_root,
} from './sh'
import { has_current_rpe, install_rpe } from './rpe'
import { start_websocket_server, get_open_port, SocketMessage } from './socket'
import { StatusBar } from './status_bar'
import { get_sdk_path } from './path'
import { prompt_configure_extensions } from './onboard'
import { focus_window } from './window'

const logger = get_logger()

interface LaunchRenpyOptions {
	intent?: string
	/**
	 * fs path representing the current editor. selects the file to warp to. if
	 * null, simply open ren'py and detect the project root
	 */
	file?: string
	/** zero-indexed line number. if set, warp to line will be attempted */
	line?: number
	context: vscode.ExtensionContext
	pm: ProcessManager
	follow_cursor: FollowCursor
	status_bar: StatusBar
}

/**
 * starts or warps depending on arguments and settings specified for the
 * extension
 *
 * if strategy is `Update Window`, no new window is opened and the current one
 * is updated instead.
 *
 * @returns
 * resolves with the process if a new instance was opened, otherwise undefined
 */
export async function launch_renpy({
	intent,
	file,
	line,
	context,
	pm,
	status_bar,
	follow_cursor,
}: LaunchRenpyOptions): Promise<ManagedProcess | undefined> {
	const is_development_mode =
		context.extensionMode === vscode.ExtensionMode.Development

	logger.info('launch_renpy:', { file, line })

	if (!file) {
		file = await vscode.workspace
			.findFiles('**/game/**/*.rpy', null, 1)
			.then((files) => (files.length ? files[0].fsPath : undefined))
	}

	if (!file) {
		vscode.window.showErrorMessage("No Ren'Py project in workspace", 'OK')
		return
	}

	const project_root = find_project_root(file)
	const filename_relative = path.relative(
		path.join(project_root, 'game/'),
		file
	)
	logger.debug('game root:', project_root)

	if (!project_root) {
		vscode.window.showErrorMessage(
			'Unable to find "game" folder in parent directory. Not a Ren\'Py project?',
			'OK'
		)
		logger.info(`cannot find game root in ${file}`)
		return
	}

	const strategy = get_config('strategy')
	let extensions_enabled = get_config('renpyExtensionsEnabled')

	if (
		pm.length &&
		line !== undefined &&
		Number.isInteger(line) &&
		strategy === 'Update Window' &&
		extensions_enabled === 'Enabled'
	) {
		logger.info('warping in existing window')

		const rpp = pm.at(-1) as AnyProcess

		await rpp.warp_to_line(filename_relative, line + 1)

		status_bar.notify(
			`$(debug-line-by-line) Warped to ${filename_relative}:${line + 1}`
		)

		if (get_config('focusWindowOnWarp') && rpp.pid) {
			logger.info('focusing window')
			await focus_window(rpp.pid)
		}

		return
	} else {
		logger.info("opening new ren'py window")

		status_bar.update(({ starting_processes }) => ({
			starting_processes: starting_processes + 1,
		}))

		try {
			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			const executable = await get_executable(sdk_path, true)
			if (!executable) return

			if (extensions_enabled === 'Not set') {
				await prompt_configure_extensions(executable)
				extensions_enabled = get_config('renpyExtensionsEnabled')
			}

			if (extensions_enabled === 'Enabled') {
				if (
					!(await has_current_rpe({ executable, sdk_path, context }))
				) {
					const installed_path = await install_rpe({
						sdk_path,
						project_root,
						context,
						executable,
					})
					vscode.window
						.showInformationMessage(
							`Ren'Py Extensions were installed/updated`,
							'OK',
							'Show'
						)
						.then((selection) => {
							if (selection === 'Show') {
								show_file(installed_path)
							}
						})
				} else if (is_development_mode) {
					await install_rpe({
						sdk_path,
						project_root,
						context,
						executable,
					})
				}
			}

			let socket_port: number | undefined

			if (extensions_enabled === 'Enabled') {
				socket_port = await get_open_port()
				await start_websocket_server({
					pm,
					port: socket_port,
					async message_handler(process, message) {
						if (message.type === 'current_line') {
							logger.debug(
								`current line reported as ${message.relative_path}:${message.line}`
							)
							if (follow_cursor.active_process === process) {
								await sync_editor_with_renpy({
									path: message.path,
									relative_path: message.relative_path,
									line: message.line - 1,
								})
							}
						} else {
							logger.warn('unhandled message:', message)
						}
					},
				})
			}

			if (strategy === 'Replace Window') pm.kill_all()

			const running_nonce = Math.trunc(Math.random() * 2047483648)

			const renpy_sh = await add_env(executable, {
				WARP_IS_MANAGED: '1',
				WARP_WS_PORT: socket_port?.toString(),
				WARP_WS_NONCE: running_nonce.toString(),
				// see: https://www.renpy.org/doc/html/editor.html
				RENPY_EDIT_PY: await get_editor_path(sdk_path),
			})
			if (!renpy_sh) throw new Error('no renpy.sh found')

			let cmd: string

			if (line === undefined) {
				cmd = renpy_sh + ' ' + sh`${project_root}`
			} else {
				cmd =
					renpy_sh +
					' ' +
					sh`${project_root} --warp ${filename_relative}:${line + 1}`
			}

			return await vscode.window.withProgress(
				{
					title: "Starting Ren'Py" + (intent ? ' ' + intent : ''),
					location: vscode.ProgressLocation.Notification,
					cancellable: true,
				},
				async (_, cancel) => {
					logger.info('executing subshell:', cmd)
					const process = child_process.exec(cmd)
					logger.info('created process', process.pid)

					const rpp = new ManagedProcess({
						process,
						project_root: project_root,
					})
					pm.add(running_nonce, rpp)

					status_bar.update(({ running_processes }) => ({
						running_processes: running_processes + 1,
					}))

					if (
						extensions_enabled === 'Enabled' &&
						(get_config('followCursorOnLaunch') ||
							follow_cursor.active_process) // follow cursor is already active, replace it
					) {
						logger.info('enabling follow cursor for new process')
						await follow_cursor.set(rpp)

						if (pm.length > 1) {
							status_bar.notify(
								`$(debug-line-by-line) Now following pid ${rpp.pid}`
							)
						}
					}

					cancel.onCancellationRequested(() => {
						rpp.kill()
					})

					if (extensions_enabled === 'Enabled') {
						try {
							await rpp.wait_for_socket(10_000)
						} catch (e: any) {
							logger.error('timed out waiting for socket:', e)
							if (rpp.dead === false) {
								vscode.window.showErrorMessage(
									"Timed out trying to connect to Ren'Py window. Is the socket client running?",
									'OK'
								)
							}
						}
					}

					status_bar.update(({ starting_processes }) => ({
						starting_processes: starting_processes - 1,
					}))

					return rpp
				}
			)
		} catch (e) {
			status_bar.update(({ starting_processes }) => ({
				starting_processes: starting_processes - 1,
			}))
			throw e
		}
	}
}
