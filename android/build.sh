#!/usr/bin/env bash
# Builds Suite Bookings APK without Gradle. Usage: SERVER_URL=https://... ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$HOME/android-sdk}"
BT="$SDK/build-tools/34.0.0"
JAR="$SDK/platforms/android-34/android.jar"
SERVER_URL="${SERVER_URL:?set SERVER_URL to the booking server address}"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0}"
KS="${KEYSTORE:-release.keystore}"
KS_PASS="${KEYSTORE_PASS:-suitebookings}"

rm -rf build && mkdir -p build/gen/com/suitebookings/app build/classes build/dex
cat > build/gen/com/suitebookings/app/BuildConfig.java <<JAVA
package com.suitebookings.app;
public final class BuildConfig { public static final String DEFAULT_URL = "${SERVER_URL}"; }
JAVA
"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/base.apk -I "$JAR" --manifest AndroidManifest.xml build/res.zip --java build/gen \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME"
javac -nowarn --release 8 -classpath "$JAR" -d build/classes $(find src build/gen -name '*.java')
"$BT/d8" --min-api 24 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
(cd build/dex && zip -q ../base.apk classes.dex)
"$BT/zipalign" -f 4 build/base.apk build/aligned.apk
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass "$KS_PASS" -keypass "$KS_PASS" -alias suite -keyalg RSA -keysize 2048 \
    -validity 10000 -dname "CN=Suite Bookings" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$KS_PASS" --out build/SuiteBookings.apk build/aligned.apk
echo "Built $(pwd)/build/SuiteBookings.apk"
