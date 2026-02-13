Get-CimInstance Win32_Process -Filter 'Name="node.exe"' | Where-Object { $_.CommandLine -match 'dist' } | Select-Object ProcessId,CommandLine | Format-List
