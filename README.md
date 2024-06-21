# Ren'Py Launch and Sync

Launch and sync your Ren'Py game at the current line in Visual Studio Code.

## Commands

This extension adds the following commands:

| Command                        | Description                                   | Shortcut                                     | Shortcut (Mac)                             |
| ------------------------------ | --------------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| `renpyWarp.warpToLine`         | Open Ren'Py at the current line               | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> |
| `renpyWarp.warpToFile`         | Open Ren'Py at the current file               | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> |
| `renpyWarp.launch`             | Launch the Ren'Py project                     | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> |
| `renpyWarp.toggleFollowCursor` | Toggle: Warp to selected line as cursor moves | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> |
| `renpyWarp.killAll`            | Kill running Ren'Py instances                 | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> |

## Triggers

The commands can be triggered in several ways:

1. By using title bar run menu ![](images/tab_bar.png)
2. By using the right click context in an editor ![](images/editor_context.png)
3. By using the right click context menu in the file explorer
   ![](images/explorer_context.png)
4. By using the status bar ![](images/status_bar.png)
5. By opening the command palette and typing the command, i.e.
   `Renpy: Open Ren'Py at current line`
6. Via keyboard shortcut ([see here](#commands))

## Configuration

You must set <code codesetting="renpyWarp.sdkPath">renpyWarp.sdkPath</code> to a
directory where the Ren'Py SDK can be found. If you haven't done so, a prompt
will appear to inform you to set it.

### Strategy

You may want to customize what to do with an open Ren'Py instance when a new
command is issued. In Renpy Launch and Sync, this is called a "strategy".

The strategy is controlled with the setting
<code codesetting="renpyWarp.strategy">renpyWarp.strategy</code>, which can be
set to one of the following values:

<dl>
   <dt><strong>Auto</strong></dt>
   <dd>
      Automatically choose the best strategy based on what features are available
   </dd>
   <dt><strong>New window</strong></dt>
   <dd>
      Open a new Ren'Py instance when a command is issued
   </dd>
   <dt><strong>Replace window</strong></dt>
   <dd>
      Kill the currently running Ren'Py instance and open a new one when a 
      command is issued
   </dd>
   <dt><strong>Update Window</strong></dt>
   <dd>
      <blockquote>
         ⚠️ <b>Warning</b><br>
         This feature only works if the current version of Ren'Py supports
         reading commands from <code>exec.py</code>. This means you need Ren'Py
         8.3.0 or a recent nightly builds.
      </blockquote>
      <p>
         When a command is issued, replace an open editor by sending a
         <code>renpy.warp_to_line()</code> command to the currently running 
         Ren'Py instance
      </p>
   </dd>
</dl>

### Follow Cursor

Renpy Launch and Sync can keep its cursor in sync with the Ren'Py game. The
direction of this sync can be controlled with the setting
<code codesetting="renpyWarp.followCursorMode">renpyWarp.followCursorMode</code>

<dl>
   <dt><strong>Ren'Py updates Visual Studio Code</strong></dt>
   <dd>
      The editor will move its cursor to match the current line of dialogue in 
      the game.
   </dd>
   <dt><strong>Visual Studio Code updates Ren'Py</strong></dt>
   <dd>
      Ren'Py will warp to the line being edited. Your game must be compatible
      with warping for this to work correctly.
   </dd>
   <dt><strong>Update both</strong></dt>
   <dd>
      Try and keep both in sync with each other. Because of how warping works, 
      this can be a bit janky, causing a feedback loop.
   </dd>
</dl>

## Troubleshooting

In order to use the current line/file feature, your game must be compatible with
warping as described in [the Ren'Py
documentation](https://www.renpy.org/doc/html/developer_tools.html#warping-to-a-line).
This feature has several limitations that you should be aware of, and as such
may not work in all cases.

## Attribution

The icon for this extension is a cropped rendition of the Ren'Py mascot, Eileen,
taken from [the Ren'Py website](https://www.renpy.org/artcard.html).
