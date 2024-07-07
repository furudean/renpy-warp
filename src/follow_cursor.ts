import * as vscode from 'vscode'
import { get_config } from './util'
import { ProcessManager, RenpyProcess } from './process'
import { logger } from './logger'
import path from 'upath'
import p_throttle from 'p-throttle'
import { find_game_root } from './sh'
import { ensure_websocket_server } from './rpe'

async function warp_renpy_to_cursor(process: RenpyProcess) {
	const editor = vscode.window.activeTextEditor

	if (!editor) return

	const language_id = editor.document.languageId
	const file = editor.document.uri.fsPath
	const line = editor.selection.active.line

	if (language_id !== 'renpy') return

	const game_root = find_game_root(file)
	const filename_relative = path.relative(path.join(game_root, 'game/'), file)

	const warp_spec = `${filename_relative}:${line + 1}`

	// TODO: WTF?
	// if (warp_spec === last_warp_spec) return // no change
	// last_warp_spec = warp_spec

	if (!process) {
		logger.warn('no renpy process found')
		return
	}

	await process.warp_to_line(filename_relative, line + 1)
	logger.info('warped to', warp_spec)
}

const throttle = p_throttle({
	limit: 1,
	interval: get_config('followCursorExecInterval'),
})

const warp_renpy_to_cursor_throttled = throttle(warp_renpy_to_cursor)

export class FollowCursor {
	private context: vscode.ExtensionContext
	private pm: ProcessManager | undefined
	private text_editor_handle: vscode.Disposable | undefined = undefined

	status_bar: vscode.StatusBarItem
	active: boolean = false

	constructor({ context }: { context: vscode.ExtensionContext }) {
		this.context = context

		this.status_bar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			0
		)

		context.subscriptions.push(
			vscode.commands.registerCommand(
				'renpyWarp.toggleFollowCursor',
				async () => {
					if (!this.active) {
						this.enable()
					} else {
						this.disable()
						this.text_editor_handle?.dispose()
					}
				}
			)
		)

		this.disable()
	}

	add_pm(pm: ProcessManager) {
		this.pm = pm
	}

	async enable() {
		if (!this.pm) throw new Error('no ProcessManager in FollowCursor')

		if (!get_config('renpyExtensionsEnabled')) {
			vscode.window.showErrorMessage(
				"Follow cursor only works with Ren'Py extensions enabled.",
				'OK'
			)
			return
		}

		if (this.pm.length > 1) {
			vscode.window.showErrorMessage(
				"Can't follow cursor with multiple open processes",
				'OK'
			)
		}

		const process = this.pm.at(0)

		if (process === undefined) {
			vscode.window.showErrorMessage(
				"Ren'Py not running. Cannot follow cursor.",
				'OK'
			)
			return
		}

		this.active = true

		this.status_bar.text = '$(pinned) Following Cursor'
		this.status_bar.color = new vscode.ThemeColor(
			'statusBarItem.warningForeground'
		)
		this.status_bar.backgroundColor = new vscode.ThemeColor(
			'statusBarItem.warningBackground'
		)

		// TODO: handle errors
		await ensure_websocket_server({ pm: this.pm })
		await process.wait_for_socket()

		this.text_editor_handle?.dispose()
		this.text_editor_handle = vscode.window.onDidChangeTextEditorSelection(
			async (event) => {
				if (
					[
						"Visual Studio Code updates Ren'Py",
						'Update both',
					].includes(get_config('followCursorMode')) &&
					event.kind !== vscode.TextEditorSelectionChangeKind.Command
				) {
					await warp_renpy_to_cursor_throttled(process)
				}
			}
		)
		this.context.subscriptions.push(this.text_editor_handle)

		if (
			["Visual Studio Code updates Ren'Py", 'Update both'].includes(
				get_config('followCursorMode')
			)
		) {
			await warp_renpy_to_cursor_throttled(process)
		}
	}

	disable() {
		this.active = false

		this.status_bar.text = '$(pin) Follow Cursor'
		this.status_bar.command = 'renpyWarp.toggleFollowCursor'
		this.status_bar.tooltip =
			"When enabled, keep editor cursor and Ren'Py in sync"
		this.status_bar.color = undefined
		this.status_bar.backgroundColor = undefined

		this.text_editor_handle?.dispose()
		this.text_editor_handle = undefined

		// kill socket server?
	}
}
