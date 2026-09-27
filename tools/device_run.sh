#!/bin/bash
# Full on-device verification flow, run as one pass to avoid memory-pressure drift.
ADB=/c/devtools/android-sdk/platform-tools/adb.exe
APK=/c/devdocs/app/build/outputs/apk/debug/app-debug.apk
export ANDROID_HOME='C:\devtools\android-sdk'
export ANDROID_SDK_ROOT='C:\devtools\android-sdk'
export ANDROID_AVD_HOME='C:\Users\USER\.android\avd'

echo "### starting emulator"
/c/devtools/android-sdk/emulator/emulator.exe -avd docs_test \
  -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -memory 1536 -cores 2 \
  -netdelay none -netspeed full > /c/devtools/emu_run2.log 2>&1 &
EMUPID=$!
echo "emulator pid $EMUPID"

echo "### waiting for device"
"$ADB" start-server >/dev/null 2>&1
"$ADB" wait-for-device
echo "### waiting for boot"
for i in $(seq 1 60); do
  st=$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  if [ "$st" = "1" ]; then echo "booted at check $i"; break; fi
  sleep 6
done
# let the system settle
sleep 20
"$ADB" shell getprop sys.boot_completed | tr -d '\r'

echo "### installing apk"
"$ADB" install -r -t "$APK" 2>&1 | tail -3

echo "### launching"
"$ADB" logcat -c 2>/dev/null
"$ADB" shell am start -n com.docsclone.app/.MainActivity 2>&1 | tail -2

echo "### waiting for webview to render"
for i in $(seq 1 20); do
  P=$("$ADB" shell pidof com.docsclone.app 2>/dev/null | tr -d '\r')
  if [ -n "$P" ]; then
    F=$("$ADB" forward --list 2>/dev/null | grep -c "9222")
    if [ "$F" = "0" ]; then
      "$ADB" forward tcp:9222 localabstract:webview_devtools_remote_$P >/dev/null 2>&1
    fi
    R=$(curl -s --max-time 4 http://127.0.0.1:9222/json 2>/dev/null | grep -c "editor/index.html")
    if [ "$R" != "0" ]; then echo "editor page live, pid=$P after $i checks"; break; fi
  fi
  sleep 3
done

echo "### probing editor"
cd /c/devdocs
node tools/device_probe.js 9222 2>&1
PROBE=$?
echo "### probe exit=$PROBE"

echo "### screenshot"
"$ADB" shell screencap -p /data/local/tmp/shot.png 2>&1
"$ADB" pull /data/local/tmp/shot.png /c/devdocs/build-test/shot.png 2>&1 | tail -1
ls -la /c/devdocs/build-test/shot.png 2>/dev/null

echo "### crash check"
"$ADB" logcat -d 2>&1 | grep -iE "FATAL EXCEPTION|AndroidRuntime.*docsclone" | tail -10
echo "### DONE exit=$PROBE"
