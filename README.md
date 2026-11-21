# CivicTrack — Civic Issue Reporting MVP

**CivicTrack** is a web-based civic issue reporting and monitoring dashboard that helps citizens report local problems, view them on an interactive map, and track their resolution status.

## Project Information

- **Project Name:** CivicTrack
- **Development:** Individual Project
- **Developer:** Developed independently by one person
- **Development Setup:** Single Laptop
- **Project Type:** Web Application
- **AI Integration:** Not included

## Features

- Citizen issue reporting with optional photo upload
- Interactive map using OpenStreetMap and Leaflet
- GPS-based location selection
- Live user location tracking
- Live location marker updates while moving
- Direction/compass indicator on supported devices
- Follow mode to keep the user's location centred on the map
- Nearby same-category report grouping within 150 metres
- Explainable priority scoring
- Admin status updates
- Local JSON data persistence
- Clearly labelled sample/demo reports
- Camera capture option for issue photos

## Technologies Used

- HTML
- CSS
- JavaScript
- Node.js
- Express.js
- Multer
- Leaflet.js
- OpenStreetMap
- Browser Geolocation API

## Requirements

- Node.js 18+ (Node.js 20+ recommended)
- Internet connection for map tiles and CDN libraries
- Modern web browser
- Location permission enabled for GPS features

## How to Run Locally

1. Download or extract the project folder.
2. Open the `CivicTrack` folder.
3. Open a terminal inside the project folder.
4. Install the required dependencies:

   ```bash
   npm install
   ```

5. Start the application:

   ```bash
   npm start
   ```

6. Open the application in your browser:

   ```text
   http://localhost:3000
   ```

## Live Location and Direction

1. Open CivicTrack in your browser.
2. Allow location permission when prompted.
3. Click **Start Live Tracking**.
4. Your current location will appear on the map.
5. The location marker updates as you move.
6. Use **Follow** to keep your location centred on the map.
7. Click **Stop Tracking** to stop live location updates.

**Note:** Live GPS requires browser location permission and a secure context such as localhost or HTTPS. Compass functionality depends on device and browser sensor support.

## Demo Flow

1. Click **Load Sample Data** to display sample civic reports.
2. Select a location on the map or use GPS.
3. Upload an issue photo or capture one using the camera.
4. Enter the issue details and submit the complaint.
5. View the newly created report on the map and dashboard.
6. Update the report status to Verified, In Progress or Resolved.
7. Observe the dashboard counters updating.
8. Demonstrate live location tracking and direction support.

## Individual Development

This project was developed independently by a single developer using one laptop.

All project activities, including frontend development, backend development, integration, testing and demonstration, were carried out on the same laptop.

## Important Limitations

- OpenStreetMap displays mapped geographic features; it does not automatically identify current potholes or damaged infrastructure.
- Duplicate grouping uses a simple prototype rule: same category within 150 metres.
- Priority scoring is a prototype ranking, not an official safety assessment.
- GPS accuracy depends on the device, browser and network conditions.
- Compass functionality may not be available on all devices.
- Local JSON storage is suitable for demonstration purposes, not large-scale production.
- Production deployment would require a database, secure authentication and appropriate access controls.
- Follow OpenStreetMap attribution and tile usage policies.

## Future Improvements

- Integrate MongoDB for permanent data storage.
- Implement secure admin authentication.
- Improve report filtering and search.
- Improve live location and direction support.
- Add deployment and hosting support.
- Integrate reverse geocoding to display readable addresses.

## Project Goal

The goal of CivicTrack is to simplify civic issue reporting by allowing citizens to submit local problems, identify their locations on a map and monitor the progress of their resolution.

---
