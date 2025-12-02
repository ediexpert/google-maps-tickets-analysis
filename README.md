# Google Maps Tickets Analysis

A web-based tool to analyze ticket prices from Google Maps using Puppeteer.

## Features

- 🔒 Password-protected web interface
- 🎫 Automated ticket price extraction from Google Maps
- 📧 Email notifications with results
- 📊 CSV export of pricing data
- 🖼️ Screenshot capture of admission pages

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file (copy from `.env.example`):
```bash
cp .env.example .env
```

3. Configure your settings in `.env`:
```env
ADMIN_PASSWORD=your_secure_password
PORT=3000
SEND_EMAIL=false
PLACES=Img World of Adventure,Another Place
```

## Usage

### Web Interface (Recommended)

1. Start the server:
```bash
npm start
```

2. Open your browser to `http://localhost:3000`

3. Enter your password (from `.env` file)

4. Click "Run Analysis Script" to start the analysis

The button will be disabled while the script is running and will re-enable when complete.

### Command Line

You can also run the script directly:
```bash
npm run analyze
```

Or with a specific place:
```bash
node index.js "Place Name"
```

## Configuration

- `ADMIN_PASSWORD`: Password to access the web interface
- `PORT`: Server port (default: 3000)
- `SEND_EMAIL`: Enable/disable email notifications
- `PLACES`: Comma-separated list of places to analyze
- `OPEN_EXTERNAL_LINKS`: Whether to open and screenshot external ticket links

## Output

- `prices-*.csv`: CSV files with ticket pricing data
- `gmap-admission-*.png`: Screenshots of admission pages
- `tab-*-*.png`: Screenshots of external ticket sites (if enabled)