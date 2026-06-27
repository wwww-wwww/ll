#!/usr/bin/env bash
exec xvfb-run java -noverify -Xverify:none -jar build/libs/extmanager-all.jar

