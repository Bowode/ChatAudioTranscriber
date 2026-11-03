#!/bin/sh
# ChatAudioTranscriber Portable FFmpeg 9.0.2; unmodified official source.
# Tested cross toolchain: Ubuntu 24.04, x86_64-w64-mingw32-gcc 13-posix, GNU make.
# No external codec libraries.
set -eu
tar -xf ffmpeg-9.0.2.tar.xz
cd ffmpeg-9.0.2
./configure --target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32- --enable-cross-compile --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug --disable-asm --disable-x86asm --disable-gpl --disable-nonfree --disable-ffprobe --disable-ffplay --enable-ffmpeg --enable-small --enable-protocol=file,pipe --enable-demuxer=wav,pcm_s16le --enable-decoder=pcm_s16le --enable-encoder=pcm_s16le --enable-muxer=wav --enable-filter=aresample,anull,aformat,abuffer,abuffersink --enable-swresample --extra-ldflags=-static --pkg-config=false
make -j4
