from flask import Flask, request, jsonify
from flask_cors import CORS
import osmnx as ox
import networkx as nx
import random
from itertools import permutations

app = Flask(__name__)
CORS(app)

# Load graph
G = ox.load_graphml(r"PATH TO YOUR DOWNLOADED MAP FILE")


# ================= VEHICLE PROFILES =================
VEHICLE_PROFILES = {
    "car": {
        "speed_multiplier": 1.0,
        "allowed_highways": [
            "motorway","trunk","primary","secondary","tertiary",
            "residential","service","unclassified","road"
        ],
        "forbidden_highways": []
    },
    "scooter": {
        "speed_multiplier": 0.75,
        "allowed_highways": [
            "primary","secondary","tertiary","residential",
            "service","unclassified","road"
        ],
        "forbidden_highways": ["motorway","trunk"]
    },
    "walking": {
        "fixed_speed_kmh": 5,
        "allowed_highways": [
            "residential","footway","path","pedestrian","service"
        ],
        "forbidden_highways": ["motorway","trunk","primary"]
    }
}


# ================= HELPERS =================
def get_highway_type(data):
    hw = data.get("highway", "unclassified")
    if isinstance(hw, list):
        hw = hw[0]
    return str(hw).lower()


def get_speed_limit(data):
    return 30  # default fallback speed


# ================= CSP CLASS =================
class VehicleCSP:

    def __init__(self, vehicle="car", avoided_road_names=None):
        self.profile = VEHICLE_PROFILES.get(vehicle, VEHICLE_PROFILES["car"])
        self.vehicle = vehicle
        self.avoided_road_names = [r.lower() for r in (avoided_road_names or [])]

    def edge_passes_hard_constraints(self, data):

        hw = get_highway_type(data)

        if not any(a in hw for a in self.profile["allowed_highways"]):
            return False

        if any(f in hw for f in self.profile["forbidden_highways"]):
            return False

        road_name = str(data.get("name","")).lower()
        for avoided in self.avoided_road_names:
            if avoided in road_name:
                return False

        return True

    def compute_edge_speed(self, data):

        if self.vehicle == "walking":
            return self.profile["fixed_speed_kmh"]

        base_speed = get_speed_limit(data)
        return base_speed * self.profile["speed_multiplier"]


# ================= RANDOM TRAFFIC =================
def apply_csp_and_random_traffic(G, csp):

    G_work = G.copy()
    to_remove = []

    for u, v, k, data in G_work.edges(keys=True, data=True):

        # Apply CSP constraints
        if not csp.edge_passes_hard_constraints(data):
            to_remove.append((u, v, k))
            continue

        # Base speed
        base_speed = csp.compute_edge_speed(data)

        # RANDOM TRAFFIC
        traffic_factor = random.uniform(0, 1)

        data["traffic_factor"] = traffic_factor

        # Assign color
        if traffic_factor > 0.66:
            data["color"] = "blue"      # light
        elif traffic_factor > 0.33:
            data["color"] = "orange"    # medium
        else:
            data["color"] = "red"       # heavy

        # Final speed
        current_speed = base_speed * max(traffic_factor, 0.1)

        data["current_speed"] = current_speed

        # Weight for A*
        data["weight"] = data["length"] / current_speed

    G_work.remove_edges_from(to_remove)

    return G_work


# ================= STOP OPTIMIZATION =================
def find_optimal_stop_order(G, start_node, stop_nodes):

    if len(stop_nodes) <= 1:
        return stop_nodes

    all_nodes = [start_node] + stop_nodes
    cost = {}

    for i, u in enumerate(all_nodes):
        for j, v in enumerate(all_nodes):
            if i != j:
                try:
                    cost[(i, j)] = nx.astar_path_length(G, u, v, weight="weight")
                except:
                    cost[(i, j)] = float("inf")

    best_cost = float("inf")
    best_order = list(range(1, len(all_nodes)))

    for perm in permutations(range(1, len(all_nodes))):
        route = [0] + list(perm)

        total = sum(
            cost[(route[i], route[i+1])]
            for i in range(len(route)-1)
        )

        if total < best_cost:
            best_cost = total
            best_order = list(perm)

    return [stop_nodes[i - 1] for i in best_order]


# ================= BUILD ROUTE =================
def build_segments(path, G):

    segments = []
    total_distance = 0

    for i in range(len(path)-1):

        u, v = path[i], path[i+1]
        edge_data = G.get_edge_data(u, v)

        if edge_data:

            edge = min(edge_data.values(), key=lambda x: x["weight"])

            total_distance += edge["length"]

            segments.append({
                "start": {
                    "lat": G.nodes[u]["y"],
                    "lon": G.nodes[u]["x"]
                },
                "end": {
                    "lat": G.nodes[v]["y"],
                    "lon": G.nodes[v]["x"]
                },
                "color": edge["color"]
            })

    return segments, total_distance / 1000


def calculate_eta(path, G):

    total_time = 0

    for i in range(len(path)-1):

        edge_data = G.get_edge_data(path[i], path[i+1])

        if edge_data:

            edge = min(edge_data.values(), key=lambda x: x["weight"])

            total_time += edge["length"] / max(edge["current_speed"], 1)

    return round(total_time / 60, 1)


# ================= ROUTE API =================
@app.route("/route", methods=["POST"])
def route():

    try:
        data = request.json

        start_lat = float(data["start_lat"])
        start_lon = float(data["start_lon"])
        stops = data.get("stops", [])

        vehicle = data.get("vehicle", "car")
        avoided_roads = data.get("avoided_roads", [])

        csp = VehicleCSP(vehicle, avoided_roads)

        # Apply CSP + RANDOM TRAFFIC
        G_work = apply_csp_and_random_traffic(G, csp)

        start_node = ox.distance.nearest_nodes(G_work, start_lon, start_lat)

        stop_nodes = [
            ox.distance.nearest_nodes(G_work, float(s["lon"]), float(s["lat"]))
            for s in stops
        ]

        # Optimize order
        ordered_stop_nodes = find_optimal_stop_order(G_work, start_node, stop_nodes)

        # Build full path
        full_path = []
        all_nodes = [start_node] + ordered_stop_nodes

        for i in range(len(all_nodes)-1):

            segment = nx.astar_path(
                G_work,
                all_nodes[i],
                all_nodes[i+1],
                weight="weight"
            )

            if i > 0:
                segment = segment[1:]

            full_path.extend(segment)

        segments, distance_km = build_segments(full_path, G_work)
        eta = calculate_eta(full_path, G_work)

        return jsonify({
            "traffic": segments,
            "distance_km": round(distance_km, 2),
            "eta_minutes": eta
        })

    except Exception as e:
        print("ERROR:", e)
        return jsonify({"error": str(e)}), 500


@app.route("/")
def home():
    return "Smart Route Planner (CSP + Random Traffic)"


if __name__ == "__main__":
    app.run(debug=True)
