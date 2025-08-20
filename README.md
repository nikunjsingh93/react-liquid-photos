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
- **Admin Tools**:
  - "Scan Media" menu with **Full Rescan** and **Scan Path** (admin-only)
  - Create users with an **Admin** toggle
  - Default admin from env (`ADMIN_USER`) cannot be deleted; other admins can
  - Optional per-user library scope via `root_path`

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

## Admin: Scan Media

- **Full Rescan**: Re-index the entire library
- **Scan Path**: Re-index only a selected folder path (useful after adding/renaming a folder)
- Renamed folders: scanning now prunes stale entries so only the new folder name is shown
- "Scan Media" controls are visible to admins only

## System Dependencies

Install these on the host (for Docker images, they are included):

- `ffmpeg` – video thumbnails and HLS support
- `exiftool` – EXIF extraction and RAW preview
- `libheif` / `heif-convert` – HEIC/HEIF preview (optional but recommended)

## Development (local)

Prerequisites:
- Node.js 18+
- pnpm or npm
- The system dependencies listed above

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up environment variables (create a `.env` or export in your shell):
   ```bash
   # Required: Path to your photos directory
   PHOTOS_PATH=/absolute/path/to/your/Pictures

   # Optional: Server configuration
   HOST=0.0.0.0
   PORT=6363

   # Optional: live file watching (0/1); if enabled, changes are auto-indexed
   WATCH_ENABLED=1

   # Optional: initial admin (created only if no admin exists yet)
   ADMIN_USER=admin
   ADMIN_PASS=admin123
   ```

3. Start the development servers (API + Vite):
   ```bash
   npm run dev
   ```

4. Open `http://localhost:5173`

## Docker

The server expects your library to be mounted at `/pictures` inside the container (default if `PHOTOS_PATH` is not set). Cache and generated assets live in `/app/.cache`.

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

## Notes

- On first run, if no admin exists, a default admin is created from `ADMIN_USER`/`ADMIN_PASS`. That specific admin cannot be deleted.
- For Docker, ensure Docker Desktop (macOS/Windows) has access to your host folders.
- When using **Scan Path** after renames, stale entries under the scanned (or nearest existing parent) directory are pruned so only the new folder name remains.
