@echo off
rem 더블클릭용. 콘솔 창을 띄우지 않고 widget.ps1을 부른다.
rem 인자는 그대로 넘어간다:  widget.cmd -Width 520 -OnTop
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0widget.ps1" %*
