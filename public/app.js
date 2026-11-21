const $ = id => document.getElementById(id);

// ==========================================
// 1. GLOBAL MAP INITIALIZATION
// ==========================================

const map = L.map("map").setView([20.5937, 78.9629], 5);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const markers = L.layerGroup().addTo(map);

let issues = [];
let selected = null;
let selectionMarker = null;
let lastSearchTime = 0;
const searchCache = new Map();

// ==========================================
// 2. LOCATION SELECTION
// ==========================================

function setLocation(lat, lon) {
  selected = { lat, lon };
  $("latitude").value = lat;
  $("longitude").value = lon;
  $("coords").textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

  if (selectionMarker) {
    selectionMarker.setLatLng([lat, lon]);
  } else {
    selectionMarker = L.circleMarker([lat, lon], {
      radius: 9,
      color: "#246bfd",
      fillColor: "#246bfd",
      fillOpacity: 0.85,
      weight: 3
    }).addTo(map);
  }

  selectionMarker.bindPopup("<b>Selected complaint location</b>");
}

map.on("click", e => setLocation(e.latlng.lat, e.latlng.lng));

// ==========================================
// 3. GLOBAL LOCATION SEARCH
// ==========================================

async function searchLocation() {
  const input = $("location-search");
  const resultsBox = $("search-results");
  const button = $("search-location-btn");
  const query = input.value.trim();

  if (!query) {
    resultsBox.textContent = "Please enter a city, street or building name.";
    return;
  }

  const cacheKey = query.toLowerCase();
  if (searchCache.has(cacheKey)) {
    displaySearchResults(searchCache.get(cacheKey));
    return;
  }

  const waitTime = 1100 - (Date.now() - lastSearchTime);
  button.disabled = true;
  button.textContent = "Searching...";

  try {
    if (waitTime > 0) await new Promise(resolve => setTimeout(resolve, waitTime));
    lastSearchTime = Date.now();
    resultsBox.textContent = "Searching for location...";

    const url = "https://nominatim.openstreetmap.org/search?" +
      new URLSearchParams({
        q: query,
        format: "jsonv2",
        limit: "5",
        addressdetails: "1"
      });

    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Location search service unavailable.");

    const data = await response.json();
    if (!data.length) {
      resultsBox.textContent = "No locations found. Try another search.";
      return;
    }

    searchCache.set(cacheKey, data);
    displaySearchResults(data);
  } catch (error) {
    resultsBox.textContent = "Search failed. Check your internet connection and try again.";
    console.error("Location search:", error);
  } finally {
    button.disabled = false;
    button.textContent = "Search";
  }
}

function displaySearchResults(data) {
  const resultsBox = $("search-results");
  resultsBox.replaceChildren();

  data.forEach(place => {
    const resultButton = document.createElement("button");
    resultButton.type = "button";
    resultButton.className = "search-result";
    resultButton.textContent = place.display_name;

    resultButton.addEventListener("click", () => {
      const lat = Number(place.lat);
      const lon = Number(place.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      setLocation(lat, lon);

      if (place.boundingbox) {
        const bounds = [
          [Number(place.boundingbox[0]), Number(place.boundingbox[2])],
          [Number(place.boundingbox[1]), Number(place.boundingbox[3])]
        ];
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16, animate: true });
      } else {
        map.flyTo([lat, lon], 16, { duration: 1.2 });
      }

      selectionMarker
        .bindPopup(`<b>Selected location</b><br>${escapeHtml(place.display_name)}`)
        .openPopup();

      resultsBox.replaceChildren();
    });

    resultsBox.appendChild(resultButton);
  });
}

$("search-location-btn").addEventListener("click", searchLocation);
$("location-search").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchLocation();
  }
});

// ==========================================
// 4. LIVE LOCATION AND DIRECTION
// ==========================================

let liveWatchId = null;
let liveLocationMarker = null;
let liveAccuracyCircle = null;
let liveDirectionMarker = null;
let followLiveLocation = true;
let lastGpsHeading = null;
let compassHeading = null;
let orientationListening = false;
let lastLivePosition = null;

function normalizeHeading(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function makeDirectionIcon(heading) {
  const rotation = normalizeHeading(heading);
  return L.divIcon({
    className: "live-direction-icon",
    html: `<div class="direction-arrow" style="transform: rotate(${rotation}deg)" aria-label="Direction ${Math.round(rotation)} degrees">▲</div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19]
  });
}

function updateDirectionMarker(lat, lon, heading) {
  if (!Number.isFinite(heading)) return;
  const icon = makeDirectionIcon(heading);

  if (liveDirectionMarker) {
    liveDirectionMarker.setLatLng([lat, lon]);
    liveDirectionMarker.setIcon(icon);
  } else {
    liveDirectionMarker = L.marker([lat, lon], {
      icon,
      interactive: false,
      zIndexOffset: 1200
    }).addTo(map);
  }
}

function getBestHeading(position) {
  if (Number.isFinite(compassHeading)) return compassHeading;
  if (Number.isFinite(position.coords.heading) && position.coords.speed > 0.5) {
    return normalizeHeading(position.coords.heading);
  }
  return lastGpsHeading;
}

function handleLivePosition(position) {
  const lat = position.coords.latitude;
  const lon = position.coords.longitude;
  const accuracy = position.coords.accuracy || 0;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  if (!liveLocationMarker) {
    liveLocationMarker = L.circleMarker([lat, lon], {
      radius: 9,
      color: "#ffffff",
      weight: 3,
      fillColor: "#1687ff",
      fillOpacity: 1
    }).addTo(map).bindPopup("<b>Your live location</b>");
  } else {
    liveLocationMarker.setLatLng([lat, lon]);
  }

  if (liveAccuracyCircle) {
    liveAccuracyCircle.setLatLng([lat, lon]).setRadius(accuracy);
  } else {
    liveAccuracyCircle = L.circle([lat, lon], {
      radius: accuracy,
      color: "#1687ff",
      weight: 1,
      opacity: 0.45,
      fillColor: "#1687ff",
      fillOpacity: 0.08
    }).addTo(map);
  }

  // GPS heading is a direction of travel, not necessarily the direction the person faces.
  if (Number.isFinite(position.coords.heading) &&
      position.coords.speed > 0.5 &&
      position.coords.heading >= 0) {
    lastGpsHeading = normalizeHeading(position.coords.heading);
  }

  const heading = getBestHeading(position);
  if (Number.isFinite(heading)) {
    updateDirectionMarker(lat, lon, heading);
    $("direction-status").textContent =
      `${compassHeading !== null ? "Compass" : "Movement"} direction: ${Math.round(heading)}°`;
  } else {
    $("direction-status").textContent =
      "Direction unavailable — move with GPS or enable device compass.";
  }

  $("live-location-status").textContent =
    `Live location active · Accuracy about ${Math.round(accuracy)} m`;

  lastLivePosition = { lat, lon };

  if (followLiveLocation) {
    map.panTo([lat, lon], { animate: true, duration: 0.5 });
  }
}

function handleLiveLocationError(error) {
  const messages = {
    1: "Location permission denied. Allow location access in your browser.",
    2: "Your current location is unavailable. Check GPS/location settings.",
    3: "Location request timed out. Try again outdoors."
  };
  $("live-location-status").textContent =
    messages[error.code] || "Could not get live location.";
  stopLiveTracking();
}

function handleDeviceOrientation(event) {
  let heading = null;

  // iOS Safari provides webkitCompassHeading.
  if (Number.isFinite(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading;
  } else if (Number.isFinite(event.alpha)) {
    // For devices exposing absolute orientation, alpha is compass-referenced.
    if (event.absolute === true) heading = 360 - event.alpha;
  }

  if (Number.isFinite(heading)) {
    compassHeading = normalizeHeading(heading);
    if (lastLivePosition) {
      updateDirectionMarker(lastLivePosition.lat, lastLivePosition.lon, compassHeading);
      $("direction-status").textContent = `Compass direction: ${Math.round(compassHeading)}°`;
    }
  }
}

async function enableCompass() {
  if (!("DeviceOrientationEvent" in window)) {
    $("direction-status").textContent =
      "Compass sensor is not available. GPS movement direction may still work.";
    return;
  }

  try {
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") {
        $("direction-status").textContent =
          "Compass permission not granted. GPS movement direction may still work.";
        return;
      }
    }

    if (!orientationListening) {
      window.addEventListener("deviceorientationabsolute", handleDeviceOrientation, true);
      window.addEventListener("deviceorientation", handleDeviceOrientation, true);
      orientationListening = true;
    }
  } catch (error) {
    console.warn("Compass permission:", error);
    $("direction-status").textContent =
      "Compass access unavailable. GPS movement direction may still work.";
  }
}

function startLiveTracking() {
  if (!navigator.geolocation) {
    $("live-location-status").textContent = "This browser does not support location tracking.";
    return;
  }
  if (liveWatchId !== null) return;

  $("start-live-btn").disabled = true;
  $("live-location-status").textContent = "Requesting location permission...";

  enableCompass();

  liveWatchId = navigator.geolocation.watchPosition(
    handleLivePosition,
    handleLiveLocationError,
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 20000
    }
  );

  $("start-live-btn").disabled = false;
  $("start-live-btn").textContent = "▶ Start Live Tracking";
  $("stop-live-btn").disabled = false;
}

function stopLiveTracking() {
  if (liveWatchId !== null) {
    navigator.geolocation.clearWatch(liveWatchId);
    liveWatchId = null;
  }

  if (orientationListening) {
    window.removeEventListener("deviceorientationabsolute", handleDeviceOrientation, true);
    window.removeEventListener("deviceorientation", handleDeviceOrientation, true);
    orientationListening = false;
  }

  $("start-live-btn").disabled = false;
  $("start-live-btn").textContent = "▶ Start Live Tracking";
  $("stop-live-btn").disabled = true;
  $("live-location-status").textContent = "Live tracking stopped.";
  $("direction-status").textContent = "Direction tracking stopped.";

  if (liveLocationMarker) map.removeLayer(liveLocationMarker);
  if (liveAccuracyCircle) map.removeLayer(liveAccuracyCircle);
  if (liveDirectionMarker) map.removeLayer(liveDirectionMarker);

  liveLocationMarker = null;
  liveAccuracyCircle = null;
  liveDirectionMarker = null;
  lastLivePosition = null;
  lastGpsHeading = null;
  compassHeading = null;
}

$("start-live-btn").addEventListener("click", startLiveTracking);
$("stop-live-btn").addEventListener("click", stopLiveTracking);
$("follow-live-btn").addEventListener("click", () => {
  followLiveLocation = !followLiveLocation;
  $("follow-live-btn").textContent = followLiveLocation ? "Following: ON" : "Following: OFF";
  if (followLiveLocation && lastLivePosition) {
    map.panTo([lastLivePosition.lat, lastLivePosition.lon], { animate: true });
  }
});

// One-time GPS button for selecting a complaint location.
$("gps-btn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showMessage("This browser does not support GPS.", true);
    return;
  }

  $("gps-btn").disabled = true;
  $("gps-btn").textContent = "Locating...";

  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      setLocation(lat, lon);
      map.flyTo([lat, lon], 17);
      selectionMarker.bindPopup("<b>Your current location</b>").openPopup();
      $("gps-btn").disabled = false;
      $("gps-btn").textContent = "📍 Use My Current Location";
    },
    () => {
      showMessage("GPS permission/location unavailable. Select a location on the map instead.", true);
      $("gps-btn").disabled = false;
      $("gps-btn").textContent = "📍 Use My Current Location";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ==========================================
// 5. LIVE WEBCAM CAPTURE
// ==========================================

let cameraStream = null;
let capturedPhotoFile = null;
let previewObjectUrl = null;

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  $("camera-video").srcObject = null;
}

function clearCapturedPhoto() {
  capturedPhotoFile = null;
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
  $("preview").src = "";
  $("preview").hidden = true;
}

function resetCameraControls() {
  $("camera-video").hidden = true;
  $("capture-photo-btn").hidden = true;
  $("close-camera-btn").hidden = true;
  $("open-camera-btn").hidden = false;
  $("open-camera-btn").textContent = "📷 Open Camera";
}

$("open-camera-btn").addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    showMessage("Camera is unavailable. Use Chrome with localhost or HTTPS.", true);
    return;
  }

  try {
    stopCamera();
    clearCapturedPhoto();

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    $("camera-video").srcObject = cameraStream;
    $("camera-video").hidden = false;
    await $("camera-video").play();

    $("open-camera-btn").hidden = true;
    $("capture-photo-btn").hidden = false;
    $("close-camera-btn").hidden = false;
    showMessage("Camera opened successfully. Capture the issue photo.");
  } catch (error) {
    let message = "Could not open camera.";
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      message = "Camera permission denied. Allow camera access in your browser.";
    } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      message = "No webcam detected on this device.";
    } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      message = "Camera is being used by another application.";
    }
    stopCamera();
    resetCameraControls();
    showMessage(message, true);
    console.error("Camera error:", error);
  }
});

$("capture-photo-btn").addEventListener("click", () => {
  const video = $("camera-video");
  if (!cameraStream || !video.videoWidth) {
    showMessage("Wait for the camera preview to appear.", true);
    return;
  }

  const canvas = $("camera-canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const context = canvas.getContext("2d");
  if (!context) {
    showMessage("Photo capture is not supported.", true);
    return;
  }

  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  canvas.toBlob(blob => {
    if (!blob) {
      showMessage("Photo capture failed. Try again.", true);
      return;
    }

    if (blob.size > 5 * 1024 * 1024) {
      showMessage("Photo must be smaller than 5 MB.", true);
      return;
    }

    clearCapturedPhoto();
    capturedPhotoFile = new File([blob], `civictrack-${Date.now()}.jpg`, {
      type: "image/jpeg"
    });
    previewObjectUrl = URL.createObjectURL(capturedPhotoFile);
    $("preview").src = previewObjectUrl;
    $("preview").hidden = false;

    stopCamera();
    $("camera-video").hidden = true;
    $("capture-photo-btn").hidden = true;
    $("close-camera-btn").hidden = true;
    $("open-camera-btn").hidden = false;
    $("open-camera-btn").textContent = "Retake Photo";
    showMessage("Photo captured successfully.");
  }, "image/jpeg", 0.88);
});

$("close-camera-btn").addEventListener("click", () => {
  stopCamera();
  $("camera-video").hidden = true;
  $("capture-photo-btn").hidden = true;
  $("close-camera-btn").hidden = true;
  $("open-camera-btn").hidden = false;
  $("open-camera-btn").textContent = capturedPhotoFile ? "Retake Photo" : "📷 Open Camera";
  showMessage("Camera closed.");
});

// ==========================================
// 6. MESSAGE DISPLAY AND HTML SECURITY
// ==========================================

function showMessage(message, error = false) {
  $("form-message").textContent = message;
  $("form-message").className = `message ${error ? "error" : "success"}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function safeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function safeCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(4) : "—";
}

// ==========================================
// 7. DASHBOARD AND REPORT RENDERING
// ==========================================

function render() {
  $("total-count").textContent = issues.length;
  $("high-count").textContent = issues.filter(x =>
    ["High", "Critical"].includes(x.priority)
  ).length;
  $("progress-count").textContent = issues.filter(x =>
    ["Assigned", "In Progress"].includes(x.status)
  ).length;
  $("resolved-count").textContent = issues.filter(x =>
    x.status === "Resolved"
  ).length;

  markers.clearLayers();

  issues.filter(issue => issue.status !== "Resolved").forEach(issue => {
    const lat = Number(issue.latitude);
    const lon = Number(issue.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const color = ["High", "Critical"].includes(issue.priority)
      ? "#e85d5d"
      : issue.priority === "Medium"
        ? "#e9ad42"
        : "#27b27e";

    const marker = L.circleMarker([lat, lon], {
      radius: 8,
      color,
      fillColor: color,
      fillOpacity: 0.85,
      weight: 2
    });

    marker.bindPopup(`
      <b>${escapeHtml(issue.category)}</b><br>
      ${escapeHtml(issue.description)}
      <br><b>Priority:</b> ${escapeHtml(issue.priority)}
      <br><b>Status:</b> ${escapeHtml(issue.status)}
      ${issue.demo ? "<br><i>Sample demo data</i>" : ""}
    `);
    marker.addTo(markers);
  });

  const body = $("reports-body");

  if (!issues.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">No reports yet. Submit a report or load sample data.</td></tr>';
    return;
  }

  body.innerHTML = issues.slice(0, 50).map(issue => {
    const imageHtml = issue.imageUrl
      ? `<img class="issue-thumb" src="${escapeHtml(issue.imageUrl)}" data-full-image="${escapeHtml(issue.imageUrl)}" alt="Photo of ${escapeHtml(issue.category || "civic issue")}" loading="lazy">`
      : '<div class="issue-thumb no-photo" aria-label="No photo">No photo</div>';

    const statusOptions = ["Submitted", "Verified", "Assigned", "In Progress", "Resolved"]
      .map(status => `
        <option value="${status}" ${issue.status === status ? "selected" : ""}>${status}</option>
      `).join("");

    return `
      <tr>
        <td><code>${escapeHtml(issue.id || "—")}</code></td>
        <td><div class="issue-cell">${imageHtml}<b>${escapeHtml(issue.category || "Uncategorized")}</b></div></td>
        <td class="description-cell">${escapeHtml(issue.description || "—")}</td>
        <td><span class="pill ${escapeHtml(issue.priority || "Low")}">${escapeHtml(issue.priority || "Low")}${issue.priorityScore != null ? ` · ${escapeHtml(issue.priorityScore)}` : ""}</span></td>
        <td>
          <select class="status-select" data-id="${escapeHtml(issue.id)}" aria-label="Update status for ${escapeHtml(issue.category || "report")}">
            ${statusOptions}
          </select>
        </td>
        <td>${safeCoordinate(issue.latitude)}, ${safeCoordinate(issue.longitude)}</td>
        <td>${escapeHtml(safeDate(issue.createdAt))}</td>
      </tr>
    `;
  }).join("");

  body.querySelectorAll(".status-select").forEach(select => {
    select.addEventListener("change", async event => {
      const control = event.currentTarget;
      const id = control.dataset.id;
      const newStatus = control.value;
      control.disabled = true;

      try {
        const response = await fetch(`/api/issues/${encodeURIComponent(id)}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: newStatus })
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Status update failed.");
        await loadIssues();
      } catch (error) {
        alert(error.message);
        await loadIssues();
      }
    });
  });
}

// ==========================================
// 8. LOAD COMPLAINTS
// ==========================================

async function loadIssues() {
  const response = await fetch("/api/issues");
  if (!response.ok) throw new Error("Could not load reports.");
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("The reports API returned an invalid response.");
  issues = data;
  render();
}

// ==========================================
// 9. SUBMIT CIVIC COMPLAINT
// ==========================================

$("issue-form").addEventListener("submit", async event => {
  event.preventDefault();

  if (!$("latitude").value || !$("longitude").value) {
    showMessage("Choose a location using search, the map or GPS.", true);
    return;
  }

  if (!$("category").value || !$("description").value.trim()) {
    showMessage("Select a category and enter an issue description.", true);
    return;
  }

  const file = capturedPhotoFile;
  if (!file && !confirm("No image captured. Submit this report without a photo?")) return;

  const data = new FormData();
  data.append("latitude", $("latitude").value);
  data.append("longitude", $("longitude").value);
  data.append("category", $("category").value);
  data.append("description", $("description").value.trim());
  data.append("address", "Selected on CivicTrack map");
  if (file) data.append("image", file);

  $("submit-btn").disabled = true;
  $("submit-btn").textContent = "Submitting...";

  try {
    const response = await fetch("/api/issues", { method: "POST", body: data });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Submission failed.");

    showMessage(result.message || "Report submitted successfully.");

    $("issue-form").reset();
    stopCamera();
    clearCapturedPhoto();
    resetCameraControls();

    if (selected) {
      $("latitude").value = selected.lat;
      $("longitude").value = selected.lon;
      $("coords").textContent = `${selected.lat.toFixed(5)}, ${selected.lon.toFixed(5)}`;
    }

    await loadIssues();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    $("submit-btn").disabled = false;
    $("submit-btn").innerHTML = "Submit Report";
  }
});

// ==========================================
// 10. REFRESH AND DEMO DATA
// ==========================================

$("refresh-btn").addEventListener("click", () => {
  loadIssues().catch(error => alert(error.message));
});

$("seed-btn")?.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/demo-seed", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load sample data.");
    alert(result.message || "Sample data loaded.");
    await loadIssues();
  } catch (error) {
    alert(error.message);
  }
});

// ==========================================
// 11. FULL-SCREEN REPORT PHOTO PREVIEW
// ==========================================

const imageModal = document.createElement("div");
imageModal.id = "image-modal";
imageModal.className = "image-modal";
imageModal.hidden = true;
imageModal.setAttribute("role", "dialog");
imageModal.setAttribute("aria-modal", "true");
imageModal.setAttribute("aria-label", "Full-size report photo");

imageModal.innerHTML = `
  <div class="image-modal-content">
    <button type="button" class="image-modal-close" id="image-modal-close" aria-label="Close image preview">&times;</button>
    <img id="modal-preview-image" src="" alt="Full-size civic report photo">
  </div>
`;

document.body.appendChild(imageModal);
const modalPreviewImage = $("modal-preview-image");

function openReportImage(src) {
  if (!src) return;
  modalPreviewImage.src = src;
  imageModal.hidden = false;
  document.body.style.overflow = "hidden";
  $("image-modal-close").focus();
}

function closeReportImage() {
  imageModal.hidden = true;
  modalPreviewImage.src = "";
  document.body.style.overflow = "";
}

document.addEventListener("click", event => {
  const reportImage = event.target.closest("#reports-body img.issue-thumb");
  if (reportImage) {
    event.preventDefault();
    openReportImage(reportImage.dataset.fullImage || reportImage.src);
    return;
  }

  if (event.target === imageModal || event.target.closest("#image-modal-close")) {
    closeReportImage();
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !imageModal.hidden) closeReportImage();
});

// ==========================================
// 12. APPLICATION INITIALIZATION
// ==========================================

async function init() {
  try {
    const healthResponse = await fetch("/api/health");
    if (!healthResponse.ok) throw new Error("Backend health check failed.");
    await healthResponse.json();

    $("system-status").textContent = "CivicTrack system online";
    await loadIssues();
    setTimeout(() => map.invalidateSize(), 200);
  } catch (error) {
    $("system-status").textContent = "API connection error";
    console.error("CivicTrack initialization:", error);
  }
}

init();
