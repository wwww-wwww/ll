import json

a = json.load(open(R"H:\LLD\all_series.json"))
ids = []
print(len(a))
a = [c["url"].split("/")[-1] for c in a]
#print(a)
b = json.load(open(R"H:\LLD\mangagrass\ids.json", encoding="utf-8"))
#print([c for c in a if "fit" in c])
#print([c for c in b if "fit" in c])
print((set(a) - set(b)))
