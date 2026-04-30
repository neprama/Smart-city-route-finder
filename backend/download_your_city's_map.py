import os
import osmnx as ox

if not os.path.exists("data/pune_roads.graphml"): #Path/name of the downloaded map file
    graph = ox.graph_from_place("Pune, India", network_type="drive") #Your city name instead of Pune
    ox.save_graphml(graph, "data/pune_roads.graphml")#Path/name of the downloaded map file for saving it in the location
    print("Map downloaded!")
else:
    print("Map already exists!")
