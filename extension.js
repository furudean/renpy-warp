const vscode = require('vscode')
const path = require('upath')
const child_process = require('node:child_process')
const os = require('node:os')
const fs = require('node:fs/promises')
const untildify = require('untildify')
const { quoteForShell } = require('puka')
const p_throttle = require('p-throttle')

/** @type {ProcessManager} */
let pm

/** @type {vscode.LogOutputChannel} */
let logger

/** @type {vscode.StatusBarItem} */
let instance_status_bar

/** @type {vscode.StatusBarItem} */
let follow_cursor_status_bar

let is_follow_cursor = false

class ExecPyTimeoutError extends Error {
	/**
	 * @param {string} [message]
	 */
	constructor(message) {
		super(message)
		this.name = 'ExecPyTimeoutError'
	}
}

class ProcessManager {
	constructor() {
		/** @type {Set<child_process.ChildProcess>} */
		this.processes = new Set()

		this.update_status_bar()
	}

	/** @param {child_process.ChildProcess} process */
	add(process) {
		this.processes.add(process)
		this.update_status_bar()

		process.stdout.on('data', (data) =>
			logger.error(`process ${process.pid} stdout:`, data)
		)
		process.stderr.on('data', (data) =>
			logger.error(`process ${process.pid} stderr:`, data)
		)
		process.on('exit', (code) => {
			this.processes.delete(process)
			this.update_status_bar()

			logger.info(`process ${process.pid} exited with code ${code}`)

			if (code) {
				vscode.window
					.showErrorMessage(
						"Ren'Py process exited with errors",
						'Logs'
					)
					.then((selected) => {
						if (selected === 'Logs') logger.show()
					})
			}
		})

		if (this.length > 1 && is_follow_cursor) {
			vscode.commands.executeCommand('renpyWarp.toggleFollowCursor')
			vscode.window.showInformationMessage(
				"Follow cursor was disabled because multiple Ren'Py instances are running"
			)
		}
	}

	kill_all() {
		for (const process of this.processes) {
			process.kill(9) // SIGKILL, bypasses "are you sure" dialog
		}

		this.update_status_bar()
	}

	update_status_bar() {
		instance_status_bar.show()

		if (this.length) {
			instance_status_bar.text = `$(debug-stop) Quit Ren'Py`
			instance_status_bar.command = 'renpyWarp.killAll'
			instance_status_bar.tooltip = "Kill all running Ren'Py instances"

			follow_cursor_status_bar.show()
		} else {
			instance_status_bar.text = `$(play) Launch project`
			instance_status_bar.command = 'renpyWarp.launch'
			instance_status_bar.tooltip = "Launch new Ren'Py instance"

			follow_cursor_status_bar.hide()

			if (is_follow_cursor) {
				vscode.commands.executeCommand('renpyWarp.toggleFollowCursor')
			}
		}
	}

	get length() {
		return this.processes.size
	}
}

/**
 * @param {string} key
 * @returns {any}
 */
function get_config(key) {
	return vscode.workspace.getConfiguration('renpyWarp').get(key)
}

/**
 * @param {string} game_root
 * @returns {Promise<'New Window' | 'Replace Window' | 'Update Window'>}
 */
async function determine_strategy(game_root) {
	return get_config('strategy') === 'Auto'
		? (await supports_exec_py(game_root))
			? 'Update Window'
			: 'New Window'
		: get_config('strategy')
}

/**
 * @param {string} str
 * @returns {string}
 */
function parse_path(str) {
	return path.resolve(untildify(str))
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function file_exists(file) {
	try {
		const stat = await fs.stat(file)
		return stat.isFile()
	} catch (err) {
		return false
	}
}

/**
 * @param {string[]} cmds
 * @returns {string}
 */
function make_cmd(cmds) {
	return cmds
		.filter(Boolean)
		.map((i) => ' ' + quoteForShell(i))
		.join('')
		.trim()
}

/**
 * @param {string} filename
 * @param {string} [haystack]
 * @param {number} [depth]
 * @returns {string | null}
 */
function find_game_root(filename, haystack = null, depth = 1) {
	const workspace_root =
		vscode.workspace.workspaceFolders &&
		vscode.workspace.workspaceFolders[0]
			? vscode.workspace.workspaceFolders[0].uri.fsPath
			: null

	if (haystack) {
		haystack = path.resolve(haystack, '..')
	} else {
		haystack = path.dirname(filename)
	}

	if (path.basename(haystack) === 'game') {
		return path.resolve(haystack, '..') // return parent
	}

	if (
		haystack === workspace_root ||
		haystack === path.resolve('/') ||
		depth >= 10
	) {
		logger.info('exceeded recursion depth at', filename, haystack)
		return null
	}

	return find_game_root(filename, haystack, depth + 1)
}

/**
 * @returns {Promise<string | undefined>}
 */
async function get_renpy_sh() {
	const is_windows = os.platform() === 'win32'

	/** @type {string} */
	const sdk_path_setting = get_config('sdkPath')

	logger.debug('raw sdk path:', sdk_path_setting)

	if (!sdk_path_setting.trim()) {
		vscode.window
			.showErrorMessage(
				"Please set a Ren'Py SDK path in the settings",
				'Open Settings'
			)
			.then((selection) => {
				if (!selection) return

				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'@ext:PaisleySoftworks.renpyWarp sdkPath'
				)
			})
		return
	}

	const expanded_sdk_path = parse_path(sdk_path_setting)

	logger.debug('expanded sdk path:', expanded_sdk_path)

	// on windows, we call python.exe and pass renpy.py as an argument
	// on all other systems, we call renpy.sh directly
	// https://www.renpy.org/doc/html/cli.html#command-line-interface
	const executable_name = is_windows
		? 'lib/py3-windows-x86_64/python.exe'
		: 'renpy.sh'

	const executable = path.join(expanded_sdk_path, executable_name)

	try {
		await fs.access(executable)
	} catch (err) {
		vscode.window
			.showErrorMessage(
				`Invalid Ren'Py SDK path: ${sdk_path_setting}`,
				'Open Settings'
			)
			.then((selection) => {
				if (!selection) return
				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'@ext:PaisleySoftworks.renpyWarp sdkPath'
				)
			})
		return
	}

	/** @type {string} */
	const editor_setting = get_config('editor')

	/** @type {string} */
	let editor

	if (path.isAbsolute(editor_setting)) {
		editor = parse_path(editor_setting)
	} else {
		// relative path to launcher
		editor = path.resolve(expanded_sdk_path, editor_setting)
	}

	try {
		await fs.access(editor)
	} catch (err) {
		vscode.window
			.showErrorMessage(
				`Invalid Ren'Py editor path: '${err.editor_path}'`,
				'Open Settings'
			)
			.then((selection) => {
				if (!selection) return

				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'@ext:PaisleySoftworks.renpyWarp editor'
				)
			})
		return
	}

	if (is_windows) {
		const win_renpy_path = path.join(expanded_sdk_path, 'renpy.py')
		// set RENPY_EDIT_PY=editor.edit.py && python.exe renpy.py
		return (
			`set "RENPY_EDIT_PY=${editor}" && ` +
			make_cmd([executable, win_renpy_path])
		)
	} else {
		// RENPY_EDIT_PY=editor.edit.py renpy.sh
		return `RENPY_EDIT_PY='${editor}' ` + make_cmd([executable])
	}
}

/**
 * sets up a watcher for the `exec.py` file and returns a function that can be
 * called to write to it.
 *
 * @param {string} script
 * the script to write to `exec.py`
 *
 * @param {string} game_root
 * path to the game root
 *
 * @returns {Promise<void>}
 */
function exec_py(script, game_root) {
	const exec_path = path.join(game_root, 'exec.py')

	const exec_prelude =
		"# This file is created by Ren'Py Launch and Sync and can safely be deleted\n"

	return new Promise(async (resolve, reject) => {
		logger.info(`writing exec.py: "${script}"`)
		await fs.writeFile(exec_path, exec_prelude + script)

		let elapsed_ms = 0

		while (await file_exists(exec_path)) {
			if (elapsed_ms >= 500) return reject(new ExecPyTimeoutError())

			await new Promise((resolve) => setTimeout(resolve, 50))
			elapsed_ms += 50
		}

		logger.info("exec.py read by Ren'Py")
		resolve()
	})
}

/**
 * determine if the current version of ren'py supports exec.py.
 *
 * an instance of ren'py must be running for this to work
 *
 * @param {string} game_root
 * @returns {Promise<boolean>}
 */
async function supports_exec_py(game_root) {
	// write an exec file that does nothing and see if it executes, which
	// means the current version of ren'py supports exec.py

	if (!pm.length) {
		throw new Error('no renpy process running to test exec.py support')
	}

	try {
		await exec_py('', game_root)
		logger.info('exec.py probably supported')
		return true
	} catch (err) {
		if (err instanceof ExecPyTimeoutError) {
			logger.info('exec.py not supported')
			return false
		}

		throw err
	}
}

/**
 * starts or warps depending on arguments and settings specified for the
 * extension
 *
 * if strategy is `Update Window`, no new window is opened and the current one
 * is updated instead.
 *
 * @param {object} [options]
 * @param {string} [options.file]
 * fs path representing the current editor. selects the file to warp to. if
 * null, simply open ren'py and detect the project root
 * @param {number} [options.line]
 * zero-indexed line number. if set, warp to line will be attempted
 *
 * @returns {Promise<child_process.ChildProcess | undefined>}
 * resolves with the child process if a new instance was opened, otherwise
 * undefined
 */
async function launch_renpy({ file, line } = {}) {
	logger.info('launch_renpy:', { file, line })

	if (!file) {
		file = await vscode.workspace
			.findFiles('**/game/**/*.rpy', null, 1)
			.then((files) => (files.length ? files[0].fsPath : null))
	}

	if (!file) {
		vscode.window.showErrorMessage("No Ren'Py project in workspace")
		return
	}

	const game_root = find_game_root(file)
	logger.debug('game root:', game_root)

	if (!game_root) {
		vscode.window.showErrorMessage(
			'Unable to find "game" folder in parent directory. Not a Ren\'Py project?'
		)
		logger.info(`cannot find game root in ${file}`)
		return
	}

	const filename_relative = path.relative(path.join(game_root, 'game/'), file)

	// warp in existing ren'py window
	if (
		pm.length &&
		line &&
		(await determine_strategy(game_root)) === 'Update Window'
	) {
		if (pm.length > 1) {
			vscode.window.showErrorMessage(
				"Multiple Ren'Py instances running. Cannot warp inside open Ren'Py window."
			)
			return
		}

		await exec_py(
			`renpy.warp_to_line('${filename_relative}:${line + 1}')`,
			game_root
		).catch(() => {
			vscode.window
				.showErrorMessage(
					"Failed to warp inside active window. Your Ren'Py version may not support this feature. You may want to change the strategy in settings.",
					'Open Settings'
				)
				.then((selection) => {
					if (!selection) return
					vscode.commands.executeCommand(
						'workbench.action.openSettings',
						'@ext:PaisleySoftworks.renpyWarp strategy'
					)
				})
		})

		return
	}

	// open new ren'py window
	const renpy_sh = await get_renpy_sh()

	if (!renpy_sh) return

	/** @type {string} */
	let cmd

	if (line === undefined) {
		cmd = renpy_sh + ' ' + make_cmd([game_root])
	} else {
		cmd =
			renpy_sh +
			' ' +
			make_cmd([game_root, '--warp', `${filename_relative}:${line + 1}`])
	}

	logger.info('executing subshell:', cmd)

	const this_process = child_process.exec(cmd)
	logger.info('created process', this_process.pid)

	if (get_config('strategy') === 'Replace Window') pm.kill_all()

	pm.add(this_process)

	return this_process
}

/**
 * @param {string} message
 * @param {() => Promise<any>} run
 * @returns {() => void}
 */
function associate_progress_notification(message, run) {
	return () => {
		vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: message,
			},
			async () => {
				await run()
			}
		)
	}
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	/** @type {vscode.Disposable} */
	let text_editor_handle

	/** @type {string | undefined} */
	let last_warp_spec

	logger = vscode.window.createOutputChannel("Ren'Py Launch and Sync", {
		log: true,
	})

	instance_status_bar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		0
	)

	follow_cursor_status_bar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		0
	)

	follow_cursor_status_bar.text = '$(pin) Follow cursor'
	follow_cursor_status_bar.command = 'renpyWarp.toggleFollowCursor'
	follow_cursor_status_bar.tooltip =
		"When enabled, Ren'Py will continuously warp to the line being edited"

	pm = new ProcessManager()

	const throttle = p_throttle({
		limit: 1,
		// renpy only reads exec.py every 100ms. but writing the file more
		// frequently is more responsive
		interval: get_config('followCursorExecInterval'),
	})

	const follow_cursor = throttle(async () => {
		if (pm.length !== 1) {
			logger.info(
				'needs exactly one instance to follow... got',
				pm.length
			)

			await vscode.commands.executeCommand('renpyWarp.toggleFollowCursor')
			return
		}

		const file = vscode.window.activeTextEditor.document.uri.fsPath
		const line = vscode.window.activeTextEditor.selection.active.line

		const game_root = find_game_root(file)
		const filename_relative = path.relative(
			path.join(game_root, 'game/'),
			file
		)

		const warp_spec = `${filename_relative}:${line + 1}`

		if (warp_spec === last_warp_spec) return // no change
		last_warp_spec = warp_spec

		await exec_py(`renpy.warp_to_line('${warp_spec}')`, game_root)
	})

	context.subscriptions.push(
		logger,
		instance_status_bar,

		vscode.commands.registerCommand(
			'renpyWarp.warpToLine',
			associate_progress_notification('Warping to line...', () =>
				launch_renpy({
					file: vscode.window.activeTextEditor.document.uri.fsPath,
					line: vscode.window.activeTextEditor.selection.active.line,
				})
			)
		),

		vscode.commands.registerCommand(
			'renpyWarp.warpToFile',
			associate_progress_notification('Warping to file...', () =>
				launch_renpy({
					file: vscode.window.activeTextEditor.document.uri.fsPath,
					line: 0,
				})
			)
		),

		vscode.commands.registerCommand(
			'renpyWarp.launch',
			associate_progress_notification("Launching Ren'Py...", () =>
				launch_renpy()
			)
		),

		vscode.commands.registerCommand('renpyWarp.killAll', () =>
			pm.kill_all()
		),

		follow_cursor_status_bar,

		vscode.commands.registerCommand(
			'renpyWarp.toggleFollowCursor',
			async () => {
				if (!is_follow_cursor) {
					if (pm.length === 0) {
						vscode.window.showErrorMessage(
							"No Ren'Py instances running. Cannot follow cursor."
						)
						return
					}

					if (pm.length > 1) {
						vscode.window.showErrorMessage(
							"Multiple Ren'Py instances running. Cannot follow cursor."
						)
						return
					}

					const game_root = find_game_root(
						vscode.window.activeTextEditor
							? vscode.window.activeTextEditor.document.uri.fsPath
							: await vscode.workspace
									.findFiles('**/game/**/*.rpy', null, 1)
									.then((files) =>
										files.length ? files[0].fsPath : null
									)
					)

					if (!game_root) {
						vscode.window.showErrorMessage(
							"Unable to find game root. Not a Ren'Py project?"
						)
						return
					}
					if (!(await supports_exec_py(game_root))) {
						vscode.window
							.showErrorMessage(
								"Your Ren'Py version does not support following cursor. Please update Ren'Py or change the strategy in settings.",
								'Open Settings'
							)
							.then((selection) => {
								if (!selection) return
								vscode.commands.executeCommand(
									'workbench.action.openSettings',
									'@ext:PaisleySoftworks.renpyWarp strategy'
								)
							})
						return
					}

					is_follow_cursor = true
					follow_cursor_status_bar.text =
						'$(pinned) Stop following cursor'
					follow_cursor_status_bar.color = new vscode.ThemeColor(
						'statusBarItem.warningForeground'
					)
					follow_cursor_status_bar.backgroundColor =
						new vscode.ThemeColor('statusBarItem.warningBackground')

					text_editor_handle =
						vscode.window.onDidChangeTextEditorSelection(
							follow_cursor
						)
					context.subscriptions.push(text_editor_handle)

					follow_cursor()
				} else {
					is_follow_cursor = false
					follow_cursor_status_bar.text = '$(pin) Follow cursor'
					follow_cursor_status_bar.backgroundColor = undefined
					follow_cursor_status_bar.color = undefined
					text_editor_handle.dispose()
				}
			}
		)
	)
}

function deactivate() {
	pm.kill_all()
}

module.exports = {
	activate,
	deactivate,
}
