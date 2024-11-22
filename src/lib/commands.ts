import * as vscode from 'vscode'
import { get_config, set_config } from './config'
import { launch_renpy } from './launch'
import { prompt_configure_extensions } from './onboard'
import { get_sdk_path, resolve_path, path_exists, path_is_sdk } from './path'
import { prompt_install_rpe, uninstall_rpes } from './rpe'
import { get_executable } from './sh'
import { WarpSocketService } from './socket'
import { ProcessManager } from './process'
import { StatusBar } from './status_bar'
import { FollowCursor, sync_editor_with_renpy } from './follow_cursor'
import { get_logger } from './logger'
import { focus_window } from './window'

const logger = get_logger()

export function get_commands(
	context: vscode.ExtensionContext,
	pm: ProcessManager,
	status_bar: StatusBar,
	follow_cursor: FollowCursor,
	wss: WarpSocketService
) {
	const commands: Record<
		string,
		(...args: unknown[]) => Promise<unknown> | unknown
	> = {
		'renpyWarp.launch': async () => {
			try {
				await launch_renpy({ context, pm, status_bar, wss })
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		},

		'renpyWarp.warpToLine': async () => {
			const editor = vscode.window.activeTextEditor
			if (!editor) return

			try {
				await launch_renpy({
					intent: 'at line',
					file: editor?.document.uri.fsPath,
					line: editor?.selection.active.line,
					context,
					pm,
					status_bar,
					wss,
				})
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		},

		'renpyWarp.warpToFile': async (uri: unknown) => {
			const fs_path =
				uri instanceof vscode.Uri
					? uri.fsPath
					: vscode.window.activeTextEditor?.document.uri.fsPath

			try {
				await launch_renpy({
					intent: 'at file',
					file: fs_path,
					line: 0,
					context,
					pm,
					status_bar,
					wss,
				})
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		},

		'renpyWarp.jumpToLabel': async () => {
			if (get_config('renpyExtensionsEnabled') !== 'Enabled') {
				vscode.window.showErrorMessage(
					"Ren'Py extensions must be enabled to use this feature",
					'OK'
				)
				return
			}

			let process = pm.at(-1)

			if (process === undefined) {
				process = await launch_renpy({
					pm,
					status_bar,
					wss,
					context,
					extra_environment: {
						RENPY_SKIP_SPLASHSCREEN: '1',
					},
				})
				if (process === undefined) return
				await process.wait_for_labels(500)
			}

			if (process.labels === undefined) {
				vscode.window.showErrorMessage(
					"Ren'Py has not reported any labels",
					'OK'
				)
				return
			}

			// https://www.renpy.org/doc/html/label.html#special-labels
			const renpy_special_labels = [
				// 'start',
				'quit',
				'after_load',
				'splashscreen',
				'before_main_menu',
				// 'main_menu',
				'after_warp',
				'hide_windows',
			]

			const filtered_labels = process.labels
				.filter(
					(label) =>
						!label.startsWith('_') &&
						!label.endsWith('_screen') &&
						!renpy_special_labels.includes(label)
				)
				.sort()

			const selection = await vscode.window.showQuickPick(
				filtered_labels,
				{
					placeHolder: 'Select a label to jump to',
					title: "Jump to Ren'Py label",
					ignoreFocusOut: true,
				}
			)

			if (selection === undefined) return

			const promises = [process.jump_to_label(selection)]

			if (get_config('focusWindowOnWarp') && process.pid) {
				promises.push(focus_window(process.pid))
			}

			await Promise.all(promises)

			status_bar.notify(
				`$(debug-line-by-line) Jumped to label '${selection}'`
			)
		},

		'renpyWarp.toggleFollowCursor': async () => {
			if (follow_cursor.enabled) {
				follow_cursor.off()

				if (!pm.length) {
					status_bar.notify('$(pin) Follow Cursor: Off')
				}
			} else {
				const process = pm.at(-1)

				if (process === undefined) {
					status_bar.notify('$(pinned) Follow Cursor: On')
					follow_cursor.enabled = true
					return
				}

				await follow_cursor.set(process)
			}
		},

		'renpyWarp.syncCursorPosition': async () => {
			const recent = pm.at(-1)
			const last_cursor = recent?.last_cursor

			if (last_cursor === undefined) {
				vscode.window.showInformationMessage(
					'Sync Cursor Position: No cursor reported from process yet',
					'OK'
				)
				return
			}
			await sync_editor_with_renpy({
				line: last_cursor.line - 1,
				path: last_cursor.path,
				relative_path: last_cursor.relative_path,
				force: true,
			})
		},

		'renpyWarp.killAll': () => pm.kill_all(),

		'renpyWarp.installRpe': async () => {
			await prompt_install_rpe(context, undefined, true)
		},

		'renpyWarp.uninstallRpe': async () => {
			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			await uninstall_rpes(sdk_path)
			vscode.window.showInformationMessage(
				"Ren'Py extensions were successfully uninstalled from the project"
			)
		},

		'renpyWarp.setSdkPath': async () => {
			const input_path = await vscode.window.showInputBox({
				title: "Set Ren'Py SDK path",
				prompt: "Input path to the Ren'Py SDK you want to use",
				value: get_config('sdkPath') as string,
				placeHolder: '~/renpy-8.2.3-sdk',
				ignoreFocusOut: true,
				async validateInput(value) {
					const parsed_path = resolve_path(value)

					const [exists, is_sdk] = await Promise.all([
						path_exists(parsed_path),
						path_is_sdk(parsed_path),
					])

					if (!exists) return 'Path does not exist'
					if (!is_sdk) return "Path is not a Ren'Py SDK"

					return null
				},
			})
			if (!input_path) return

			await set_config('sdkPath', input_path)

			return input_path
		},

		'renpyWarp.setExtensionsPreference': async () => {
			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			const executable = await get_executable(sdk_path, true)
			if (!executable) return

			await prompt_configure_extensions(executable)
		},

		'renpyWarp.startSocketServer': async () => {
			if (get_config('renpyExtensionsEnabled') === 'Enabled') {
				await wss.start()
			} else {
				vscode.window.showErrorMessage(
					"Ren'Py extensions must be enabled to use the socket server",
					'OK'
				)
			}
		},

		'renpyWarp.stopSocketServer': () => {
			wss.close()
		},

		'renpyWarp.resetSupressedMessages': () => {
			context.globalState.update('hideExternalProcessConnected', false)
			context.globalState.update('hideRpeInstallUpdateMessage', false)
		},
	}

	return commands
}

export function register_commmands(
	context: vscode.ExtensionContext,
	pm: ProcessManager,
	status_bar: StatusBar,
	follow_cursor: FollowCursor,
	wss: WarpSocketService
) {
	const commands = get_commands(context, pm, status_bar, follow_cursor, wss)

	for (const [name, handler] of Object.entries(commands)) {
		context.subscriptions.push(
			vscode.commands.registerCommand(name, handler)
		)
	}
}
