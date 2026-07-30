# Rowake desktop

The Wails shell starts Rowake on a loopback port and opens the embedded web interface in a native window.

```sh
make desktop
```

Use `make desktop-dev` while working on the shell.

Add an existing SQLite database from the Connections screen; Rowake opens it in read-only mode and restores it the next time the desktop app starts.
