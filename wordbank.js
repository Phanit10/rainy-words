'use strict';

/**
 * Local word bank — used when no LLM key is configured, when the model is slow or
 * unreachable, and to top up a set if the model returns too few usable words.
 * server.js re-buckets every word by its real length, so the grouping here is only a guide.
 */
module.exports = {
  // 3–4 letters
  easy: [
    'rain', 'mist', 'hail', 'wind', 'gust', 'drip', 'drop', 'damp', 'cold', 'wet', 'fog', 'dew',
    'sky', 'sun', 'ice', 'snow', 'gale', 'pond', 'lake', 'wave', 'tide', 'flow', 'leak', 'pour',
    'soak', 'bolt', 'boom', 'dark', 'gray', 'haze', 'cool', 'calm', 'roof', 'coat', 'boot', 'mud',
    'bog', 'sea', 'bay', 'dam', 'cup', 'tub', 'jar', 'leaf', 'moss', 'fern', 'frog', 'toad',
    'duck', 'swan', 'fish', 'boat', 'sail', 'raft', 'dock', 'pier', 'surf', 'foam', 'gull', 'crab',
    'reef', 'kelp', 'wade', 'swim', 'dive', 'bath', 'well', 'tap', 'hose', 'pipe', 'moon', 'star',
  ],
  // 5–6 letters
  medium: [
    'cloud', 'storm', 'flood', 'river', 'water', 'ocean', 'drain', 'spray', 'splash', 'shower',
    'puddle', 'stream', 'breeze', 'squall', 'sleet', 'frost', 'humid', 'soggy', 'drench', 'ripple',
    'bubble', 'gutter', 'canal', 'creek', 'marsh', 'swamp', 'geyser', 'spring', 'liquid', 'vapor',
    'steam', 'misty', 'rainy', 'windy', 'gusty', 'stormy', 'cloudy', 'chilly', 'poncho', 'jacket',
    'boots', 'hoodie', 'window', 'street', 'garden', 'forest', 'meadow', 'valley', 'island',
    'harbor', 'anchor', 'paddle', 'kayak', 'canoe', 'otter', 'whale', 'shark', 'squid', 'coral',
    'pearl', 'shell', 'beach', 'coast', 'shore', 'tidal', 'delta', 'basin', 'brook', 'lagoon',
    'fjord', 'trickle',
  ],
  // 7–10 letters
  hard: [
    'thunder', 'drizzle', 'rainbow', 'monsoon', 'cyclone', 'tornado', 'typhoon', 'blizzard',
    'downpour', 'umbrella', 'raincoat', 'overcast', 'humidity', 'forecast', 'pressure',
    'lightning', 'hailstone', 'waterfall', 'whirlpool', 'hurricane', 'rainstorm', 'snowflake',
    'avalanche', 'landslide', 'reservoir', 'watershed', 'droplets', 'moisture', 'puddles',
    'torrent', 'cascade', 'current', 'tempest', 'weather', 'climate', 'sprinkle', 'raindrop',
    'rainfall', 'cloudburst', 'windstorm', 'nightfall', 'twilight', 'horizon', 'atmosphere',
    'barometer', 'condense', 'evaporate', 'saturate', 'overflow', 'flooding', 'drainage',
    'aqueduct', 'fountain', 'lakeside', 'riverbank', 'shoreline', 'lighthouse', 'submarine',
    'sailboat', 'dolphin', 'octopus', 'seaweed', 'plankton', 'tsunami', 'glacier', 'iceberg',
    'crystal', 'freezing', 'shivering', 'splashing', 'dripping', 'soaking', 'pouring',
  ],
};
