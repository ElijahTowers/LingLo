#!/usr/bin/env python3
"""Read a JSON array of Spanish words from stdin, output {word: zipf_freq} JSON."""
import sys, json
from wordfreq import zipf_frequency

words = json.load(sys.stdin)
result = {w: zipf_frequency(w, 'es') for w in words}
print(json.dumps(result))
