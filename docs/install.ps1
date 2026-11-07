# The LibrePool Windows installer lives at https://librepool.com/install.ps1
# This shim keeps old `iwr ... github.io ... | iex` one-liners working.
$ErrorActionPreference = 'Stop'
Invoke-Expression (Invoke-RestMethod -UseBasicParsing https://librepool.com/install.ps1)
