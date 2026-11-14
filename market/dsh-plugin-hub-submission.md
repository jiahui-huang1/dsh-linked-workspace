### Repository
https://github.com/jiahui-huang1/dsh-linked-workspace

### One-line value
Turns existing SSH connections into read-only remote directories and editable local⇄remote linked workspaces inside DSH.

### Category
Integrations & Connections

### Install command
dsh plugin --profile web add dsh-linked-workspace

### Compatibility
DSH 0.2.1-rc.4; Windows/macOS/Linux; dsh-better-sidebar (>=0.24.0) is optional — it only adds the sidebar directory pages and the file editor.

### License
MIT

### Screenshots / demo
https://github.com/jiahui-huang1/dsh-linked-workspace#screenshots

### Notes
Remote workspaces run sessions on the remote host; linked workspaces pair a local folder with a remote one. Hosts come from `~/.ssh/config` (SSH Manager optional); a password can be stored on this machine by the plugin itself, and credentials stay in the Host process.
