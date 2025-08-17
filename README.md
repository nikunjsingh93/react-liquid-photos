# Liquid Photos

A fast, modern photo gallery application built with React and Node.js.

## Features

- **Fast Image Loading**: Optimized image serving with multiple resolution levels
- **Responsive Design**: Works seamlessly on desktop and mobile devices
- **User Authentication**: Secure login system with user management
- **Folder Navigation**: Browse photos organized in folders
- **Full-Screen Viewer**: High-quality image viewing with optimization options
- **Download Support**: Download original quality images

## Image Optimization

The application now includes intelligent image optimization to improve loading times, especially when accessing photos outside your home network:

### Resolution Levels

1. **Thumbnails** (`/thumb/:id`): Small WebP images (512px width) for grid view
2. **Optimized View** (`/view/:id`): Medium-resolution WebP images (1920px width) for full-screen viewing
3. **Full Resolution** (`/media/:id`): Original images for high-quality viewing
4. **Download** (`/download/:id`): Original images for download

### Viewer Controls

- **Optimized Mode** (default): Fast loading with good quality for most viewing needs
- **Full Resolution Mode**: Toggle to view original quality images when needed
- **Download Button**: Always downloads the original full-quality image

### Configuration

You can customize the optimization settings using environment variables:

```bash
# Thumbnail width (default: 512px)
THUMB_WIDTH=512

# Optimized view width (default: 1920px)
VIEW_WIDTH=1920

# WebP quality for thumbnails (default: 82)
# WebP quality for optimized views (default: 85)
```

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up environment variables:
   ```bash
   # Required: Path to your photos directory
   PHOTOS_PATH=/path/to/your/photos
   
   # Optional: Server configuration
   PORT=5174
   HOST=0.0.0.0
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Open your browser to `http://localhost:5173`

## Performance Benefits

- **Faster Initial Loading**: Optimized images load much faster than full-resolution images
- **Reduced Bandwidth**: Significant bandwidth savings when viewing photos remotely
- **Better User Experience**: Smooth navigation and quick image switching
- **Flexible Quality**: Users can choose between speed and quality based on their needs

The optimization is particularly beneficial when accessing photos over slower connections or when viewing on mobile devices with limited bandwidth.
