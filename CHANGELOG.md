# Changelog

## 1.0.1

- Fixed distorted/corrupted history thumbnails
- Thumbnails now show more of the page instead of aggressively cropping
- Added "Clear" button to wipe capture history
- Removed unused dead code

## 1.0.0

- Initial release
- Full-page screenshot capture with lazy-load scrolling
- Custom viewport, DPI, dark mode, and CSS injection
- SSRF protection with DNS validation
- Rate limiting (5 req/min per IP) and concurrency control (5 simultaneous)
- Wait-for-selector support
- Automatic browser restart for stability
