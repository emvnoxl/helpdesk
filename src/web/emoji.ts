/* The emoji picker's data: a small hand-picked set (the ones people actually use at work) with search words. No library, no network. */

export interface EmojiGroup { id: string; label: string; icon: string; items: string[] } // items: "😀 grin smile happy"

export const GROUPS: EmojiGroup[] = [
  {
    id: "smileys", label: "Smileys", icon: "😀",
    items: [
      "😀 grin happy smile", "😃 smile happy open", "😄 smile laugh happy", "😁 grin beam teeth", "😆 laugh squint", "😅 sweat laugh relief phew", "🤣 rofl laughing floor", "😂 joy tears laugh lol", "🙂 smile slight", "🙃 upside down silly", "😉 wink", "😊 blush smile happy", "😇 angel innocent halo", "🥰 love hearts adore", "😍 heart eyes love", "🤩 star struck wow amazing", "😘 kiss blow love", "😋 yum tasty delicious", "😛 tongue playful", "😜 wink tongue crazy", "🤪 zany wild crazy", "😎 cool sunglasses", "🤓 nerd geek glasses", "🤗 hug thanks", "🤭 oops giggle hand mouth", "🤔 thinking hmm wonder", "🤨 eyebrow suspicious doubt", "😐 neutral meh", "😑 expressionless blank", "😶 silent no mouth", "🙄 eye roll whatever", "😏 smirk", "😬 grimace awkward yikes", "😌 relieved calm", "😔 sad pensive", "😴 sleep tired zzz", "😷 mask sick ill", "🤒 fever sick thermometer", "🤯 mind blown shocked exploding", "🥳 party celebrate birthday", "😕 confused unsure", "😟 worried concerned", "😮 surprised wow open mouth", "😲 astonished shocked", "😳 flushed embarrassed", "🥺 pleading please puppy", "😢 cry sad tear", "😭 sob crying loud", "😱 scream fear shock", "😖 confounded frustrated", "😞 disappointed sad", "😓 sweat downcast hard work", "😩 weary tired exhausted", "😤 triumph steam huff", "😡 angry mad rage", "🤬 swearing cursing angry", "😈 devil mischief", "💀 skull dead dying", "🤡 clown", "👻 ghost boo", "🤖 robot bot ai", "💩 poop",
    ],
  },
  {
    id: "people", label: "Gestures", icon: "👍",
    items: [
      "👍 thumbs up yes good ok approve like", "👎 thumbs down no bad dislike", "👌 ok perfect fine", "✌️ peace victory", "🤞 fingers crossed luck hope", "🤟 love you hand", "🤘 rock horns", "🤙 call me shaka", "👈 left point", "👉 right point", "👆 up point", "👇 down point", "☝️ index up one", "✋ stop hand high five", "🖐️ hand fingers splayed", "👋 wave hello bye hi", "🤚 raised back hand", "👏 clap applause well done bravo", "🙌 hooray praise hands celebrate", "👐 open hands", "🤲 palms up together", "🤝 handshake deal agree", "🙏 pray thanks please thank you", "✍️ writing hand", "💪 strong muscle flex power", "🦾 mechanical arm", "🧠 brain smart think", "👀 eyes look watching", "👁️ eye", "👂 ear listen", "🗣️ speaking head talk", "👤 person silhouette user", "👥 people users team", "🧑‍💻 technologist developer coder it", "👨‍💻 man technologist coder", "👩‍💻 woman technologist coder", "🧑‍🔧 mechanic fix repair", "🧑‍💼 office worker manager", "🙋 raising hand question", "🤷 shrug dont know", "🤦 facepalm oops", "🙇 bow sorry thanks", "💁 information desk help", "🏃 running rush hurry", "🚶 walking",
    ],
  },
  {
    id: "symbols", label: "Hearts & symbols", icon: "❤️",
    items: [
      "❤️ red heart love", "🧡 orange heart", "💛 yellow heart", "💚 green heart", "💙 blue heart", "💜 purple heart", "🖤 black heart", "🤍 white heart", "💔 broken heart", "💕 two hearts", "💯 hundred perfect score", "✅ check done yes complete", "☑️ ballot check", "✔️ check mark", "❌ cross no wrong", "❎ cross button", "⚠️ warning caution", "🚫 prohibited no", "⛔ no entry stop", "❗ exclamation important", "❓ question", "‼️ double exclamation", "⁉️ exclamation question", "💬 speech bubble chat message", "💭 thought bubble", "🔔 bell notification", "🔕 bell off mute", "⭐ star favourite", "🌟 glowing star", "✨ sparkles new clean", "🔥 fire hot lit", "💥 boom collision", "⚡ lightning fast power electric", "🎉 party popper celebrate congratulations", "🎊 confetti", "🏆 trophy win champion", "🥇 gold medal first", "🏅 medal", "➕ plus add", "➖ minus", "🔁 repeat loop", "🔄 refresh arrows restart reload", "⏳ hourglass waiting", "⌛ hourglass done time", "⏰ alarm clock time", "🕐 clock one", "📌 pin pushpin", "📍 location pin", "🔒 lock secure private", "🔓 unlock open", "🔑 key password", "🆘 sos help emergency", "🆗 ok button", "🆕 new", "🔴 red circle", "🟠 orange circle", "🟡 yellow circle", "🟢 green circle online", "🔵 blue circle", "⚪ white circle", "⚫ black circle", "➡️ right arrow", "⬅️ left arrow", "⬆️ up arrow", "⬇️ down arrow",
    ],
  },
  {
    id: "work", label: "Work & IT", icon: "💻",
    items: [
      "💻 laptop computer pc", "🖥️ desktop computer monitor screen", "⌨️ keyboard", "🖱️ mouse computer", "🖨️ printer print", "📱 phone mobile smartphone", "☎️ telephone phone call", "📞 phone receiver call", "📟 pager", "📠 fax", "🔌 plug power cable electric", "🔋 battery charge", "🪫 low battery", "💾 floppy save disk", "💿 cd disc", "📀 dvd", "🗄️ file cabinet", "📁 folder", "📂 open folder", "🗂️ dividers index", "📄 page document file", "📃 page curl", "📋 clipboard", "📊 bar chart stats report", "📈 chart up growth trend", "📉 chart down decline", "📝 memo note write", "✏️ pencil write", "🖊️ pen", "📎 paperclip attachment", "🔗 link chain url", "📧 email mail", "✉️ envelope letter mail", "📨 incoming envelope", "📤 outbox sent", "📥 inbox received", "📅 calendar date", "🗓️ spiral calendar schedule", "🔍 magnifying search find", "🔎 magnifying right search", "💡 light bulb idea", "🔧 wrench fix tool", "🛠️ tools hammer wrench repair", "🔨 hammer", "⚙️ gear settings cog", "🧰 toolbox", "🔩 nut bolt", "🧹 broom clean", "🧯 fire extinguisher", "🛡️ shield security protection", "🦠 virus microbe malware", "🐛 bug", "📡 satellite antenna signal", "📶 signal bars wifi", "🌐 globe internet web network", "☁️ cloud", "🏢 office building", "🏭 factory", "⛽ fuel pump oil gas", "🛢️ oil drum barrel", "🚧 construction", "🦺 safety vest", "⛑️ helmet safety", "🎧 headphones headset", "🎤 microphone mic", "📹 video camera", "📷 camera photo", "🎥 movie camera", "🔊 speaker loud sound", "🔇 muted speaker no sound",
    ],
  },
  {
    id: "nature", label: "Nature", icon: "🌿",
    items: [
      "🐶 dog", "🐱 cat", "🐭 mouse", "🐹 hamster", "🐰 rabbit bunny", "🦊 fox", "🐻 bear", "🐼 panda", "🐨 koala", "🐯 tiger", "🦁 lion", "🐮 cow", "🐷 pig", "🐸 frog", "🐵 monkey", "🙈 see no evil monkey", "🙉 hear no evil monkey", "🙊 speak no evil monkey", "🐔 chicken", "🐧 penguin", "🐦 bird", "🦉 owl wise", "🦄 unicorn", "🐝 bee busy", "🐢 turtle slow", "🐌 snail slow", "🦋 butterfly", "🐙 octopus", "🐠 fish tropical", "🐬 dolphin", "🐳 whale", "🌱 seedling growth", "🌿 herb leaf", "🍀 clover luck", "🌴 palm tree", "🌵 cactus", "🌸 blossom flower", "🌹 rose", "🌻 sunflower", "🌞 sun face", "☀️ sun sunny", "⛅ sun cloud", "🌧️ rain", "⛈️ storm thunder", "🌈 rainbow", "❄️ snowflake cold", "🌊 wave water ocean", "🌍 earth africa globe",
    ],
  },
  {
    id: "food", label: "Food & drink", icon: "☕",
    items: [
      "☕ coffee tea hot drink", "🍵 tea matcha", "🥤 cup straw soda", "🧃 juice box", "🥛 milk", "🍺 beer", "🍻 cheers beers", "🥂 clinking glasses toast", "🍷 wine", "🧊 ice cube", "🍎 apple red", "🍌 banana", "🍊 orange tangerine", "🍉 watermelon", "🍇 grapes", "🍓 strawberry", "🥭 mango", "🍍 pineapple", "🥑 avocado", "🍅 tomato", "🥕 carrot", "🌽 corn maize", "🍞 bread", "🧀 cheese", "🍳 egg cooking fried", "🥞 pancakes", "🍔 burger hamburger", "🍟 fries chips", "🍕 pizza", "🌭 hot dog", "🌯 burrito wrap", "🍗 chicken leg meat", "🍖 meat bone", "🍚 rice", "🍜 noodles ramen", "🍲 stew pot food", "🍪 cookie", "🍰 cake slice", "🎂 birthday cake", "🍩 donut", "🍫 chocolate", "🍿 popcorn", "🍦 ice cream",
    ],
  },
  {
    id: "activities", label: "Fun", icon: "⚽",
    items: [
      "⚽ football soccer", "🏀 basketball", "🏈 american football", "🎾 tennis", "🏐 volleyball", "🏓 ping pong", "🥊 boxing glove", "🎯 target bullseye goal", "🎮 video game controller", "🕹️ joystick", "🎲 dice game", "🧩 puzzle piece", "🎨 art palette", "🎬 clapper film", "🎵 music note", "🎶 music notes", "🎸 guitar", "🥁 drum", "🚗 car", "🚕 taxi", "🚌 bus", "🚚 truck delivery", "✈️ airplane flight travel", "🚀 rocket launch fast", "🏠 house home", "🏖️ beach holiday vacation", "⛺ camping tent", "🎁 gift present", "🎈 balloon", "🕯️ candle", "🔮 crystal ball", "🪄 magic wand", "🍾 champagne bottle celebrate", "🥇 first place gold", "🥈 second place silver", "🥉 third place bronze",
    ],
  },
];

export interface EmojiItem { e: string; words: string }
export const ALL: EmojiItem[] = GROUPS.flatMap((g) =>
  g.items.map((s) => {
    const i = s.indexOf(" ");
    return { e: s.slice(0, i), words: s.slice(i + 1) };
  }),
);

/** Emoji whose words start with, or contain, every word typed. Best (start-of-word) matches first. */
export function searchEmoji(q: string, limit = 80): EmojiItem[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored: { it: EmojiItem; score: number }[] = [];
  for (const it of ALL) {
    const hay = " " + it.words;
    let score = 0;
    let all = true;
    for (const t of terms) {
      if (hay.includes(" " + t)) score += 2;
      else if (hay.includes(t)) score += 1;
      else { all = false; break; }
    }
    if (all) scored.push({ it, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.it);
}

const KEY = "fortress-helpdesk:emoji-recent";
export function recentEmoji(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 24) : []; } catch { return []; }
}
export function rememberEmoji(e: string) {
  try { localStorage.setItem(KEY, JSON.stringify([e, ...recentEmoji().filter((x) => x !== e)].slice(0, 24))); } catch { /* private window */ }
}

/** The six reactions offered on a message. */
export const QUICK = ["👍", "❤️", "😂", "😮", "🙏", "🎉"];
