FROM jrottenberg/ffmpeg:4.1-ubuntu

COPY brb.mp4 /ffmpeg/brb.mp4

ENTRYPOINT ["ffmpeg"]
CMD ["-stream_loop", "-1", "-re", "-i", "/ffmpeg/brb.mp4", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "2500k", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-f", "flv", "rtmp://nginx-rtmp:1935/live/brb"]
