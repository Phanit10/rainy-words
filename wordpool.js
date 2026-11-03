'use strict';

/**
 * The word pool the AI theme words choose from (see theme-words.js): about 1,500 common, safe English words.
 * The lines are grouped by topic only to make the list easy to read and extend; the model ignores the grouping
 * and judges every word by its meaning. Words outside a-z or 3-10 letters, and repeats, are dropped on load.
 */

const POOL = `
ocean sea wave tide reef coral shell sand beach shore coast island harbor anchor sail boat ship yacht canoe kayak
surf diver fish shark whale dolphin octopus squid crab lobster shrimp oyster clam seal walrus jellyfish starfish
seaweed kelp lagoon bay current pearl lighthouse submarine sailor captain voyage mermaid tsunami buoy dock pier
marina seagull pelican salty splash swim snorkel scuba ripple

rain cloud storm thunder lightning drizzle snow hail sleet fog mist wind breeze gust gale tornado hurricane cyclone
typhoon monsoon rainbow sunshine sunny cloudy windy stormy frost humid forecast climate puddle umbrella raincoat
weather season summer winter autumn flood drought drench soggy damp chilly downpour

space planet star galaxy comet asteroid meteor moon orbit rocket astronaut alien satellite telescope cosmos nebula
universe gravity launch crater eclipse solar lunar mars venus jupiter saturn neptune spaceship shuttle capsule
cosmic stellar supernova starlight spacesuit countdown sun sky void ufo

cat dog cow pig horse sheep goat duck hen chicken rabbit mouse rat lion tiger bear wolf fox deer elk moose zebra
giraffe elephant monkey gorilla panda koala kangaroo camel hippo rhino leopard cheetah jaguar otter beaver squirrel
hedgehog badger raccoon skunk bat owl eagle hawk falcon parrot penguin ostrich peacock swan goose crow robin sparrow
pigeon frog toad snake lizard turtle tortoise crocodile alligator puppy kitten pony donkey hamster

ant bee wasp fly moth beetle spider butterfly ladybug cricket locust termite firefly mosquito dragonfly caterpillar
worm snail slug flea honeybee cocoon

farm barn tractor field crop wheat corn hay plow harvest orchard farmer scarecrow fence stable silo meadow pasture
seed soil rooster calf lamb haystack mud egg

bread rice pasta noodle soup salad cheese butter milk egg meat beef pork steak bacon ham sausage burger pizza taco
sandwich toast cereal yogurt honey jam sugar salt pepper sauce gravy curry stew omelet pancake waffle muffin cookie
cake pie donut candy chocolate caramel popcorn chips cracker pretzel dumpling sushi

apple banana orange lemon lime grape cherry peach pear plum mango melon kiwi berry papaya pineapple coconut apricot
fig strawberry blueberry raspberry watermelon avocado

carrot potato tomato onion garlic lettuce cabbage celery spinach broccoli pea bean pumpkin cucumber radish beet
turnip mushroom eggplant zucchini kale leek olive

tea coffee juice water soda lemonade cocoa smoothie milkshake latte espresso

kitchen oven stove sink fridge freezer kettle toaster blender microwave pan pot wok lid bowl plate dish cup mug glass
jar fork knife spoon ladle whisk spatula grater apron napkin recipe chef cook bake boil fry roast grill chop stir
slice peel cupboard counter tray oil salt meal food

breakfast bagel croissant oatmeal porridge syrup scramble brunch

dessert cream sundae pudding custard brownie cupcake frosting sprinkles jelly tart sorbet

sport ball goal team coach player score match game win lose referee whistle stadium arena court track race sprint
marathon relay medal trophy champion league soccer football tennis golf hockey rugby baseball basketball volleyball
boxing karate judo wrestling swimming cycling skiing skating surfing rowing archery fencing bowling kick pass shoot
dribble serve tackle helmet racket net jog hit run gym

music song melody rhythm beat tempo note chord harmony lyrics chorus verse band choir concert stage singer drummer
guitar piano violin cello flute trumpet drum harp saxophone clarinet trombone tuba banjo ukulele organ microphone
speaker album record radio dance disco jazz blues rock opera rap hum tune

school class teacher student pupil desk chair board chalk marker pencil pen eraser ruler notebook paper book library
lesson homework exam test quiz grade math science history art recess lunch bell locker backpack campus college
diploma glue tape page note essay study

computer laptop tablet phone screen keyboard monitor printer camera robot drone code program software hardware
internet website browser email server network data byte pixel chip battery charger cable wifi signal app button
click download upload password login virus update digital bot disk file link chat text web

city town street road avenue lane bridge tunnel tower building skyscraper apartment office shop store market mall
cafe bakery bank hotel museum theater cinema park plaza fountain statue station subway train bus taxi traffic
crosswalk sidewalk alley downtown suburb

car truck van tram bike bicycle scooter motorbike plane jet helicopter ferry wagon cart engine wheel tire brake gear
fuel garage driver pilot ticket airport runway highway

travel trip journey vacation holiday tourist passport luggage suitcase map guide hostel camp tent resort cruise
flight visa souvenir postcard explore adventure

mountain hill valley cliff peak summit ridge canyon cave volcano glacier rock stone pebble boulder river stream creek
lake pond waterfall forest woods tree leaf branch root bark trunk pine oak maple willow birch cedar bush grass moss
fern flower rose tulip daisy lily sunflower orchid petal bloom blossom

desert dune cactus oasis scorpion mirage heat dust sandstorm nomad

jungle rainforest vine canopy toucan python swamp mangrove bamboo ape palm tusk claw wild

garden shovel spade rake hoe hose sprout weed hedge lawn mower greenhouse compost vegetable herb basil mint parsley

home house room door window wall floor roof stairs attic basement yard porch gate key lock sofa couch table bed
pillow blanket lamp mirror carpet rug curtain shelf closet drawer clock bath shower towel soap

shirt pants jeans dress skirt coat jacket sweater hoodie scarf glove mitten hat cap boot shoe sock sandal belt tie
zipper pocket collar sleeve uniform pajamas

head face eye ear nose mouth lip tooth tongue neck shoulder arm elbow wrist hand finger thumb chest back belly hip
leg knee ankle foot toe heart lung brain bone muscle skin hair blood

doctor nurse hospital clinic medicine pill vaccine fever cough flu sneeze bandage injury wound health dentist
patient ambulance surgery healthy vitamin

happy sad angry calm brave scared afraid excited nervous proud shy lonely joy fear hope love smile laugh cry worry
relief surprise bored curious grateful jealous cheerful gloomy

job worker farmer baker police firefighter soldier artist painter writer actor dancer lawyer judge banker builder
plumber carpenter mechanic engineer scientist inventor detective reporter waiter cashier

magic wizard witch spell potion wand dragon unicorn fairy elf dwarf giant troll goblin knight castle princess prince
king queen crown throne sword shield quest legend myth phoenix griffin enchant charm curse

ancient empire kingdom pyramid temple ruins armor viking pharaoh emperor warrior battle siege fortress scroll relic
artifact

atom molecule cell gene energy force magnet electric light sound laser lab tube experiment theory formula chemical
element oxygen carbon hydrogen metal liquid gas solid physics biology chemistry microscope research fossil

dinosaur raptor extinct bones

red blue green yellow purple pink brown black white gray silver gold violet indigo crimson scarlet turquoise beige
maroon navy teal ivory

party birthday gift present candle balloon festival parade fireworks costume mask lantern celebrate wedding feast

halloween ghost skeleton zombie vampire monster spooky haunted broom cauldron coffin graveyard fang howl cape grave
tomb hood boo creak eerie scare bat

snowman sled skate fireplace reindeer sleigh ornament icicle blizzard igloo

toy puzzle dice card chess checkers marble kite yoyo doll teddy block video console joystick level bonus

movie film actress director scene script cartoon comic hero villain sequel trailer paint brush canvas easel sketch
drawing sculpture gallery color

money coin cash wallet price sale buy sell pay bill receipt discount bargain budget credit savings

time watch hour minute second day night week month year morning noon evening midnight today tomorrow yesterday
calendar century decade

fire flame spark smoke ash ember blaze torch campfire burn lava

pirate treasure chest crew deck mast flag cannon plank hook loot gold coin map

android cyborg circuit future machine sensor wire hologram

family mother father sister brother baby child kid parent grandma grandpa uncle aunt cousin friend neighbor people
crowd

run jump walk climb throw catch sing read write draw build dig eat drink sleep dream talk listen look think learn play

big small tall short fast slow hot cold new old young bright dark loud quiet soft hard sweet sour bitter spicy fresh
crisp smooth rough shiny fuzzy tiny huge gentle wild quick lazy clever silly funny

circle square triangle diamond oval cube sphere cone curve
`;

module.exports = [...new Set(POOL.split(/\s+/).filter((word) => /^[a-z]{3,10}$/.test(word)))];
