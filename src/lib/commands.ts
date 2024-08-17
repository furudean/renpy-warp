import * as vscode from 'vscode'
import { get_config, set_config } from './config'
import { launch_renpy } from './launch'
import { prompt_configure_extensions } from './onboard'
import { get_sdk_path, resolve_path, path_exists, path_is_sdk } from './path'
import { prompt_install_rpe, uninstall_rpes } from './rpe'
import { get_executable } from './sh'
import { ensure_socket_server, stop_socket_server } from './socket'
import { ProcessManager } from './process'
import { StatusBar } from './status_bar'
import { FollowCursor } from './follow_cursor'
import { get_logger } from './logger'

const logger = get_logger()

export function get_commands(
	context: vscode.ExtensionContext,
	pm: ProcessManager,
	status_bar: StatusBar,
	follow_cursor: FollowCursor
) {
	const commands: Record<
		string,
		(...args: unknown[]) => Promise<unknown> | unknown
	> = {
		'renpyWarp.launch': async () => {
			try {
				await launch_renpy({ context, pm, status_bar, follow_cursor })
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
					follow_cursor,
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
					follow_cursor,
				})
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		},

		'renpyWarp.toggleFollowCursor': () => {
			if (follow_cursor.active_process) {
				follow_cursor.off()
			} else {
				const process = pm.at(-1)

				if (process === undefined) {
					vscode.window.showErrorMessage(
						"Ren'Py not running. Cannot follow cursor.",
						'OK'
					)
					return
				}

				follow_cursor.set(process)
			}
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
					const exists = await path_exists(parsed_path)
					if (!exists) return 'Path does not exist'

					const is_sdk = await path_is_sdk(parsed_path)
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

			try {
				await prompt_configure_extensions(executable.join(' '))
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		},

		'renpyWarp.startSocketServer': async () => {
			if (get_config('renpyExtensionsEnabled') === 'Enabled') {
				const started = await ensure_socket_server({
					pm,
					status_bar,
					follow_cursor,
					context,
				})
				if (!started) {
					vscode.window
						.showErrorMessage(
							'Failed to start socket server',
							'OK',
							'Logs'
						)
						.then((selection) => {
							if (selection === 'Logs') {
								logger.show()
							}
						})
				}
			} else {
				vscode.window.showErrorMessage(
					"Ren'Py extensions must be enabled to use the socket server",
					'OK'
				)
			}
		},

		'renpyWarp.stopSocketServer': () => {
			stop_socket_server(pm, status_bar)
		},

		'renpyWarp.resetSupressedMessages': () => {
			context.globalState.update('hideExternalProcessConnected', false)
			context.globalState.update('hideRpeInstallUpdateMessage', false)
		},
	}

	return commands
}
