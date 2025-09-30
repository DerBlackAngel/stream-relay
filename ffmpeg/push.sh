#!/usr/bin/env bash
# Robust: killt beim Stop die gesamte Prozessgruppe (inkl. ffmpeg)
set -euo pipefail

# gesamte Prozessgruppe beim Beenden töten (TERM/INT)
trap 'echo "[push.sh] TERM -> kill process group"; kill -- -$$ 2>/dev/null || true; exit 0' TERM INT

SRC="${1:-}"
if [[ -z "${SRC}" ]]; then
  echo "Usage: $0 <dennis|auria|mobil|brb>" >&2
  exit 2
fi

: "${TWITCH_RTMP_URL:?TWITCH_RTMP_URL not set}"

case "$SRC" in
  dennis) KEY="${DENNIS:-}"; APP="dennis" ;;
  auria)  KEY="${AURIA:-}";  APP="auria"  ;;
  mobil)  KEY="${MOBIL:-}";  APP="mobil"  ;;
  brb)    KEY="";            APP=""       ;;
  *) echo "Unknown source: $SRC" >&2; exit 2 ;;
esac

if [[ "$SRC" == "brb" ]]; then
  INPUT=( -re -stream_loop -1 -i /work/brb.mp4 )
else
  if [[ -z "${KEY}" ]]; then
    echo "No key configured in ENV for ${SRC}. Aborting." >&2
    exit 3
  fi
  INPUT=( -re -i "rtmp://nginx-rtmp:1935/${APP}/${KEY}" )
fi

echo "[push.sh] START source=${SRC}"

while true; do
  # ffmpeg startet im Vordergrund (Kind der aktuellen Shell/Prozessgruppe)
  ffmpeg -hide_banner -loglevel warning \
    "${INPUT[@]}" \
    -c:v copy -c:a aac -ar 44100 -b:a 128k \
    -f flv "${TWITCH_RTMP_URL}" || true

  echo "[push.sh] ffmpeg ended, restarting in 2s..." >&2
  sleep 2
done
