# Liquid Photos

A fast, modern photo and video gallery application built with React and Node.js.

## Features

- **Fast Image Loading**: Optimized image serving with multiple resolution levels
- **Responsive Design**: Works seamlessly on desktop and mobile devices
- **User Authentication**: Secure login system with user management
- **Folder Navigation**: Browse media organized in folders
- **Full-Screen Viewer**: High-quality image viewing with optimization options
- **Download Support**: Download original quality images
- **Video Playback (HLS)**: Built-in player with HLS streaming for smooth video playback
- **Touch Gestures**: Intuitive swipe controls for mobile devices
- **Loading States**: Smooth loading indicators for thumbnails and navigation
- **Multi-Select**: Select multiple photos for batch download
- **Admin Tools**:
  - "Scan Media" menu with **Full Rescan** and **Scan Path** (admin-only)
  - Create users with an **Admin** toggle
  - Default admin from env (`ADMIN_USER`) cannot be deleted; other admins can
  - Optional per-user library scope via `root_path`

## Touch Interactions

Liquid Photos provides intuitive touch gestures for mobile devices, making it easy to navigate and interact with your media library.

### Full-Screen Viewer Gestures

- **Swipe Left/Right**: Navigate between photos
  - Swipe left to go to the next photo
  - Swipe right to go to the previous photo
  - Works anywhere in the full-screen viewer area

- **Swipe Up**: Open the information panel
  - Shows EXIF data, file details, and metadata
  - Works from any position in the viewer

- **Swipe Down**: Close panels or exit viewer
  - If info panel is open: closes the info panel
  - If info panel is closed: exits the full-screen viewer

### Grid View Interactions

- **Tap**: Open photo in full-screen viewer
- **Long Press**: Enter multi-select mode (mobile)
- **Multi-select**: Tap photos to select multiple items for batch download
- **Responsive Design**: Optimized for both portrait and landscape orientations

## Image & Video Optimization

The application includes intelligent optimization to improve loading times, especially when accessing your library remotely.

### Resolution Levels

1. **Thumbnails** (`/thumb/:id`): Small WebP images (default width 512px) for grid view
2. **Optimized View** (`/view/:id`): Medium-resolution WebP images (default width 1920px) for full-screen viewing
3. **Full Resolution** (`/media/:id`): Original media for high-quality viewing
4. **Download** (`/download/:id`): Original media for download

### Viewer Controls

- **Optimized Mode** (default): Fast loading with good quality for most viewing needs
- **Full Resolution Mode**: Toggle to view original quality images when needed
- **Download Button**: Always downloads the original full-quality file

### Loading States

- **Thumbnail Loading**: Smooth skeleton loading with spinners while thumbnails load
- **Tree Navigation**: Loading indicators when switching between folder and date views
- **Error Handling**: Graceful fallbacks for failed image loads

## Admin: Scan Media

- **Full Rescan**: Re-index the entire library
- **Scan Path**: Re-index only a selected folder path (useful after adding/renaming a folder)
- Renamed folders: scanning now prunes stale entries so only the new folder name is shown
- "Scan Media" controls are visible to admins only

## HLS Video Streaming Configuration

For 4K videos that may experience 500 Internal Server Error during HLS generation, you can configure the following environment variables:

```bash
# HLS Processing Configuration
HLS_TIMEOUT_4K=30000        # Timeout for 4K video processing (ms, default: 30000)
HLS_TIMEOUT_STD=8000        # Timeout for standard video processing (ms, default: 8000)
HLS_QUALITY_4K=medium       # FFmpeg preset for 4K videos (default: medium)
HLS_QUALITY_STD=veryfast    # FFmpeg preset for standard videos (default: veryfast)
HLS_DISABLED=1              # Completely disable HLS processing (default: 0)
```

### Troubleshooting 4K HLS Issues

If you experience 500 Internal Server Error with 4K videos:

1. **Increase timeout**: Set `HLS_TIMEOUT_4K=60000` for 60-second timeout
2. **Use faster preset**: Set `HLS_QUALITY_4K=veryfast` for faster processing
3. **Check server resources**: Ensure sufficient CPU and memory for 4K processing
4. **Monitor logs**: Check server console for detailed FFmpeg error messages
5. **Disable HLS entirely**: Set `HLS_DISABLED=1` to bypass HLS processing and use direct video streaming

### Video Playback Troubleshooting

**If videos are not playing in Optimized (HLS) mode:**
- Switch to "Original" mode using the quality toggle button in the video player
- This bypasses HLS processing and uses direct video streaming
- Works for all video formats and resolutions

## System Dependencies

Install these on the host (for Docker images, they are included):

- `ffmpeg` – video thumbnails and HLS support
- `exiftool` – EXIF extraction and RAW preview
- `libheif` / `heif-convert` – HEIC/HEIF preview (optional but recommended)

## Development (local)

Prerequisites:
- Docker

1. Run from your project folder root which has Dockerfile:
```bash
docker build -t liquid-photos:latest .

docker stop liquid-photos || true
docker rm liquid-photos

docker run -d \
  --name liquid-photos \
  --restart unless-stopped \
  -p 6363:6363 \
  -e HOST=0.0.0.0 \
  -e PORT=6363 \
  -e ADMIN_USER=admin \
  -e ADMIN_PASS=admin123 \
  -v "/Users/m4air/Pictures":/pictures:ro \  # <- Change it your local pictures folder
  -v "/Users/m4air/liquid-photos-cache":/app/.cache \   # <- Change it your local cache folder
  liquid-photos:latest

```

2. Open `http://localhost:6363`

## Deploy to Server using Docker

### Docker Compose

Use home folders appropriate to your OS.

```yaml
version: "3.8"
services:
  liquid-photos:
    image: nikunjsingh/liquid-photos:latest
    container_name: liquid-photos
    restart: unless-stopped
    environment:
      HOST: "0.0.0.0"
      PORT: "6363"
      ADMIN_USER: "admin" # <— change this to your admin user
      ADMIN_PASS: "admin123" # <— change this to your admin pass
    ports:
      - "6363:6363"
    volumes:
      # Linux (example)
      - /home/youruser/Pictures:/pictures:ro # <— change this to your Pictures/Videos folder
      - /home/youruser/.liquid-photos-cache:/app/.cache # <— change this to your preferred cache folder for thumbnails/DB
      # macOS (example)
      # - /Users/youruser/Pictures:/pictures:ro
      # - /Users/youruser/.liquid-photos-cache:/app/.cache
      # Windows (example; Docker Desktop)
      # - C:/Users/youruser/Pictures:/pictures:ro
      # - C:/Users/youruser/.liquid-photos-cache:/app/.cache
```

Start with:
```bash
docker compose up -d
```

### Docker Run

Linux/macOS example:
```bash
docker run -d \
  --name liquid-photos \
  --restart unless-stopped \
  -p 6363:6363 \
  -e HOST=0.0.0.0 \
  -e PORT=6363 \
  -e ADMIN_USER=admin \ # <— change this to your admin user
  -e ADMIN_PASS=admin123 \ # <— change this to your admin pass
  -v "/home/youruser/Pictures":/pictures:ro \ # <— change this to your Pictures/Videos folder
  -v "/home/youruser/.liquid-photos-cache":/app/.cache \ # <— change this to your preferred cache folder for thumbnails/DB
  nikunjsingh/liquid-photos:latest
```

## If your files are 200,000+ items first Indexing can take upto 10 minutues, Check Docker logs and wait for [index] done: 234,895 files in 694.5s before going to the WEB UI

## Notes

- On first run, if no admin exists, a default admin is created from `ADMIN_USER`/`ADMIN_PASS`. That specific admin cannot be deleted.
- For Docker, ensure Docker Desktop (macOS/Windows) has access to your host folders.
- When using **Scan Path** after renames, stale entries under the scanned (or nearest existing parent) directory are pruned so only the new folder name remains.
