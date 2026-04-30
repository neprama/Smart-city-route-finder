// Initialize map
var map = L.map('map').setView([18.5204, 73.8567], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19
}).addTo(map);

// Global state
let userMarker    = null;
let destMarker    = null;
let trafficLayers = [];
let watchId       = null;
let startMode     = 'live';
let selectedVehicle = 'car';


// ============================================================
// GEOLOCATION
// ============================================================

function getLocation() {
    const btn = document.getElementById("locationBtn");
    btn.innerText = "Getting Location...";
    btn.disabled  = true;

    if (!navigator.geolocation) {
        alert("Geolocation not supported");
        resetLocationBtn(btn);
        return;
    }

    navigator.geolocation.getCurrentPosition(
        function(position) {
            try {
                const lat = position.coords.latitude;
                const lon = position.coords.longitude;
                if (userMarker) map.removeLayer(userMarker);
                userMarker = L.marker([lat, lon])
                    .addTo(map).bindPopup("You are here").openPopup();
                map.setView([lat, lon], 14);
            } catch(err) {
                console.error(err);
                alert("Error updating map");
            }
            resetLocationBtn(btn);
        },
        function(error) {
            console.error("Geolocation error:", error.code, error.message);
            if (error.code === 1) alert("Permission denied — allow location in browser settings.");
            else if (error.code === 2) alert("Location unavailable.");
            else alert("Location request timed out.");
            resetLocationBtn(btn);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

function resetLocationBtn(btn) {
    btn.innerText = "📍 Get my location";
    btn.disabled  = false;
}


// ============================================================
// START MODE TOGGLE
// ============================================================

function selectStartMode(mode) {
    startMode = mode;
    document.getElementById('btn-live').classList.toggle('active-toggle',   mode === 'live');
    document.getElementById('btn-manual').classList.toggle('active-toggle', mode === 'manual');
    document.getElementById('start-input').style.display = mode === 'manual' ? 'block' : 'none';
    document.getElementById('locationBtn').style.display = mode === 'live'   ? 'block' : 'none';
    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
}


// ============================================================
// VEHICLE SELECTOR — CSP constraint
// ============================================================

function selectVehicle(v) {
    selectedVehicle = v;
    document.querySelectorAll('.vehicle-btn').forEach(btn => {
        btn.classList.toggle('active-vehicle', btn.dataset.v === v);
    });
}


// ============================================================
// STOPS MANAGEMENT
// ============================================================

function addStop() {
    const container = document.getElementById("stops-container");
    const count = container.querySelectorAll(".stop-input").length;
    if (count >= 3) { alert("Maximum 3 stops"); return; }
    const input = document.createElement("input");
    input.type        = "text";
    input.className   = "stop-input";
    input.placeholder = "Stop " + (count + 1);
    container.appendChild(input);
}


// ============================================================
// ROAD AVOIDANCE — CSP constraint
// ============================================================

function addAvoid() {
    const container = document.getElementById("avoid-container");
    const count = container.querySelectorAll(".avoid-row").length;
    if (count >= 5) { alert("Maximum 5 roads to avoid"); return; }
    const row = document.createElement("div");
    row.className = "avoid-row";
    row.innerHTML = `
        <input type="text" class="avoid-input" placeholder="Road name to avoid">
        <button class="avoid-remove" onclick="removeAvoid(this)" title="Remove">×</button>
    `;
    container.appendChild(row);
}

function removeAvoid(btn) {
    const container = document.getElementById("avoid-container");
    // Keep at least one row
    if (container.querySelectorAll(".avoid-row").length > 1) {
        btn.closest(".avoid-row").remove();
    } else {
        btn.closest(".avoid-row").querySelector(".avoid-input").value = "";
    }
}

function getAvoidedRoads() {
    return [...document.querySelectorAll(".avoid-input")]
        .map(i => i.value.trim())
        .filter(v => v !== "");
}


// ============================================================
// GEOCODING
// ============================================================

async function geocode(place) {
    const url = "https://nominatim.openstreetmap.org/search?format=json&q=" + encodeURIComponent(place);
    const response = await fetch(url);
    const data = await response.json();
    if (data.length === 0) { alert("Location not found: " + place); return null; }
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}


// ============================================================
// RESOLVE START
// ============================================================

function resolveStart() {
    if (startMode === 'manual') {
        const val = document.getElementById('start-input').value.trim();
        if (!val) { alert("Enter a starting location"); return Promise.resolve(null); }
        return geocode(val).then(coords => {
            if (!coords) return null;
            return { lat: coords.lat, lon: coords.lon, label: val };
        });
    }
    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            pos => resolve({
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                label: "Your Location"
            }),
            (err) => {
                console.error("Geolocation error:", err.code, err.message);
                if (err.code === 1) alert("Location permission denied.");
                else alert("Could not get location.");
                resolve(null);
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    });
}


// ============================================================
// FIND ROUTE
// ============================================================

async function findRoute() {

    const stopValues = [...document.querySelectorAll(".stop-input")]
        .map(i => i.value.trim()).filter(v => v !== "");

    if (stopValues.length === 0) {
        alert("Enter at least one stop");
        return;
    }

    const start = await resolveStart();
    if (!start) return;

    // Place start marker
    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.marker([start.lat, start.lon])
        .addTo(map).bindPopup(start.label).openPopup();

    // Clear old stop markers
    if (window._stopMarkers) window._stopMarkers.forEach(m => map.removeLayer(m));
    window._stopMarkers = [];

    // Geocode all stops
    const stopData = [];
    for (let i = 0; i < stopValues.length; i++) {
        const coords = await geocode(stopValues[i]);
        if (!coords) return;
        const marker = L.marker([coords.lat, coords.lon])
            .addTo(map)
            .bindPopup(`Stop ${i + 1}: ${stopValues[i]}`);
        window._stopMarkers.push(marker);
        stopData.push({ lat: coords.lat, lon: coords.lon, label: stopValues[i] });
    }

    // Collect CSP constraints
    const avoidsRoads = getAvoidedRoads();

    // Show loading state
    document.getElementById("info").innerHTML = "⏳ Finding route...";
    document.getElementById("stop-order-banner").style.display   = "none";
    document.getElementById("csp-warnings-banner").style.display = "none";

    // API call
    const response = await fetch("http://127.0.0.1:5000/route", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            start_lat:     start.lat,
            start_lon:     start.lon,
            stops:         stopData,
            vehicle:       selectedVehicle,     // CSP: vehicle profile
            avoided_roads: avoidsRoads          // CSP: road name avoidance
        })
    });

    const data = await response.json();

    if (!response.ok || data.error) {
        alert(data.error || "Server error");
        document.getElementById("info").innerHTML = "Distance: - <br> ETA: -";
        return;
    }

    if (!data.traffic) {
        alert("No route found");
        return;
    }

    // Clear old route
    trafficLayers.forEach(layer => map.removeLayer(layer));
    trafficLayers = [];

    // Draw new route
    data.traffic.forEach(segment => {
        const line = L.polyline([
            [segment.start.lat, segment.start.lon],
            [segment.end.lat,   segment.end.lon]
        ], { color: segment.color, weight: 6 }).addTo(map);
        trafficLayers.push(line);
    });

    if (trafficLayers.length > 0) {
        map.fitBounds(L.featureGroup(trafficLayers).getBounds());
    }

    // Optimal order banner
    if (data.ordered_stops && data.ordered_stops.length > 0) {
        document.getElementById("stop-order-text").textContent =
            start.label + " → " + data.ordered_stops.join(" → ");
        document.getElementById("stop-order-banner").style.display = "block";
    }

    // CSP warnings banner
    if (data.csp_warnings && data.csp_warnings.length > 0) {
        document.getElementById("csp-warnings-text").textContent =
            data.csp_warnings.join(" | ");
        document.getElementById("csp-warnings-banner").style.display = "block";
    }

    // Info panel — includes vehicle and avoided roads
    const avoidText = data.avoided_roads && data.avoided_roads.length > 0
        ? `<br><span style="color:#888;font-size:12px;">Avoiding: ${data.avoided_roads.join(", ")}</span>`
        : "";

    document.getElementById("info").innerHTML =
        `${data.vehicle} &nbsp;|&nbsp; Distance: ${data.distance_km} km` +
        `<br>ETA: ${data.eta_minutes} minutes` +
        avoidText;

    // Live tracking only in live mode
    if (startMode === 'live') startTracking();
}


// ============================================================
// LIVE TRACKING
// ============================================================

function startTracking() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(
        position => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            if (userMarker) userMarker.setLatLng([lat, lon]);
            map.panTo([lat, lon]);
        },
        () => { alert("Tracking failed"); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
    );
}
