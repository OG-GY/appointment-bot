const { sendMessage } = require('./whatsapp');
const { saveAppointment } = require('./sheet');

const DOCTOR_INFO = {
  name: 'Dr. Raj Kumar',
  specialty: 'General Physician',
  hours: 'Mon-Fri 9am-6pm, Sat 10am-2pm',
  mode: 'Online/Virtual Consultation',
};

const VALID_SLOTS = ['10am', '12pm', '3pm', '5pm'];
const SLOT_BY_CHOICE = { '1': '10am', '2': '12pm', '3': '3pm', '4': '5pm' };

const BOOKING_KEYWORDS = ['book', 'appointment', 'schedule'];
const RESET_KEYWORDS = ['restart', 'start over', 'reset', 'new booking'];
const CANCEL_KEYWORDS = ['cancel', 'stop booking', 'exit booking'];

const sessions = {};

const normalize = (text = '') => text.toLowerCase().trim();
const containsAny = (text, keywords) => keywords.some((k) => text.includes(k));

const slotTo24Hour = (slot) => {
  if (slot === '10am') return 10;
  if (slot === '12pm') return 12;
  if (slot === '3pm') return 15;
  if (slot === '5pm') return 17;
  return -1;
};

// Rule requested: for "today", if only 20 mins left in current hour allow next hour, else require next-to-next hour.
const getEarliestAllowedHourForToday = () => {
  const now = new Date();
  return now.getMinutes() >= 40 ? now.getHours() + 1 : now.getHours() + 2;
};

const getAvailableSlotsForDate = (dateValue) => {
  if (dateValue !== 'today') return [...VALID_SLOTS];
  const earliestHour = getEarliestAllowedHourForToday();
  return VALID_SLOTS.filter((slot) => slotTo24Hour(slot) >= earliestHour);
};

const formatSlots = (slots) => slots.map((slot, idx) => `${idx + 1}) ${slot}`).join(', ');

const extractDate = (text) => {
  const input = normalize(text);
  if (input.includes('today')) return 'today';
  if (input.includes('tomorrow')) return 'tomorrow';

  const fullDateMatch = input.match(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/);
  if (fullDateMatch) return fullDateMatch[0];

  const dayMatch = input.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (dayMatch) {
    return `${dayMatch[1] ? 'next ' : ''}${dayMatch[2]}`.trim();
  }

  return null;
};

const extractTime = (text) => {
  const input = normalize(text);
  const compact = input.replace(/\s+/g, '');

  if (/^[1-4]$/.test(input)) {
    return { slot: SLOT_BY_CHOICE[input], invalidTime: null };
  }

  if (compact.includes('10am') || /\b10\s*(am|a\.m\.?)\b/.test(input)) return { slot: '10am', invalidTime: null };
  if (compact.includes('12pm') || /\b12\s*(pm|p\.m\.?)\b/.test(input)) return { slot: '12pm', invalidTime: null };
  if (compact.includes('3pm') || /\b3\s*(pm|p\.m\.?)\b/.test(input)) return { slot: '3pm', invalidTime: null };
  if (compact.includes('5pm') || /\b5\s*(pm|p\.m\.?)\b/.test(input)) return { slot: '5pm', invalidTime: null };

  const explicitClock = input.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (explicitClock) {
    const hour = parseInt(explicitClock[1], 10);
    const meridiem = explicitClock[3].toLowerCase();
    const normalizedSlot = `${hour}${meridiem}`;
    if (VALID_SLOTS.includes(normalizedSlot)) {
      return { slot: normalizedSlot, invalidTime: null };
    }
    return { slot: null, invalidTime: `${hour}${meridiem}` };
  }

  return { slot: null, invalidTime: null };
};

const NAME_BLOCK_WORDS = new Set([
  'book', 'appointment', 'schedule', 'consult', 'consultation',
  'today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'yes', 'no', 'ok', 'okay', 'hello', 'hi', 'hey', 'my', 'name', 'is',
  'time', 'date', 'reason', 'visit', 'checkup', 'fever', 'pain',
]);

const sanitizeName = (name) => name.replace(/[^a-zA-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();

const looksLikeHumanName = (candidate) => {
  if (!candidate) return false;
  const clean = sanitizeName(candidate);
  if (clean.length < 3 || clean.length > 50) return false;

  const parts = clean.split(' ').filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return false;
  if (parts.some((p) => p.length < 2)) return false;

  const lowerParts = parts.map((p) => p.toLowerCase());
  if (lowerParts.some((p) => NAME_BLOCK_WORDS.has(p))) return false;

  return true;
};

const extractName = (text) => {
  const input = text.trim();

  const explicitPatterns = [
    /my\s+name\s+is\s+([a-zA-Z\s]{2,50})/i,
    /i\s+am\s+([a-zA-Z\s]{2,50})/i,
    /this\s+is\s+([a-zA-Z\s]{2,50})/i,
    /^([a-zA-Z\s]{2,50})\s+(?:book|appointment|schedule|for|on)\b/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = input.match(pattern);
    if (match) {
      const candidate = sanitizeName(match[1]);
      if (looksLikeHumanName(candidate)) return candidate;
    }
  }

  const standalone = sanitizeName(input);
  if (/^[a-zA-Z\s]{2,50}$/.test(standalone) && looksLikeHumanName(standalone)) {
    return standalone;
  }

  return null;
};

const extractReason = (text) => {
  const input = normalize(text);
  const reasonMatch = input.match(/(?:reason|for visit|problem|issue)\s*(?:is|:)?\s*(.+)$/i);
  if (reasonMatch && reasonMatch[1] && reasonMatch[1].trim().length >= 3) {
    return reasonMatch[1].trim();
  }

  const symptomKeywords = [
    'consultation', 'checkup', 'fever', 'pain', 'headache', 'cold', 'cough',
    'diabetes', 'blood pressure', 'stomach', 'allergy', 'follow up', 'follow-up',
  ];

  for (const keyword of symptomKeywords) {
    if (input.includes(keyword)) return keyword;
  }

  return null;
};

const createSession = () => ({
  data: {
    name: null,
    date: null,
    time: null,
    reason: null,
  },
});

const getMissingFields = (data) => {
  const missing = [];
  if (!data.name) missing.push('name');
  if (!data.date) missing.push('date');
  if (!data.time) missing.push('time');
  if (!data.reason) missing.push('reason');
  return missing;
};

const sendGeneralReply = async (from, text) => {
  const input = normalize(text);

  if (/^(hi|hello|hey)\b/.test(input)) {
    await sendMessage(from, `Hello. I can help with online doctor appointments. Type "book" to start.`);
    return;
  }

  if (containsAny(input, ['available', 'doctor'])) {
    await sendMessage(from, `Yes. ${DOCTOR_INFO.name} is available for ${DOCTOR_INFO.mode}. Type "book" to start.`);
    return;
  }

  if (containsAny(input, ['time', 'timing', 'hours', 'day', 'days', 'open'])) {
    await sendMessage(from, `Doctor hours: ${DOCTOR_INFO.hours}. Online only.`);
    return;
  }

  if (containsAny(input, ['online', 'virtual'])) {
    await sendMessage(from, `This is online consultation. You can join from home.`);
    return;
  }

  await sendMessage(from, `I can help with doctor booking. Type "book" and share date/time.`);
};

const askForMissingDetails = async (from, session) => {
  const missing = getMissingFields(session.data);

  if (missing.length === 0) return;

  if (missing.includes('date') && missing.includes('time')) {
    await sendMessage(from, `Please share date and time. Example: tomorrow 3pm.`);
    return;
  }

  const field = missing[0];

  if (field === 'name') {
    await sendMessage(from, `Please share your name.`);
    return;
  }

  if (field === 'date') {
    await sendMessage(from, `Please share date. Example: today, tomorrow, friday.`);
    return;
  }

  if (field === 'time') {
    const availableSlots = getAvailableSlotsForDate(session.data.date);
    if (session.data.date === 'today' && availableSlots.length === 0) {
      session.data.date = null;
      await sendMessage(from, `No safe slots left for today. Please choose another day.`);
      return;
    }
    await sendMessage(from, `Please choose time: ${formatSlots(availableSlots)}.`);
    return;
  }

  if (field === 'reason') {
    await sendMessage(from, `Please share reason for visit. Example: fever, checkup.`);
  }
};

const handleBookingMessage = async (from, text) => {
  if (!sessions[from]) sessions[from] = createSession();
  const session = sessions[from];
  const input = normalize(text);

  if (containsAny(input, CANCEL_KEYWORDS)) {
    delete sessions[from];
    await sendMessage(from, `Booking cancelled. Type "book" anytime to start again.`);
    return;
  }

  if (containsAny(input, RESET_KEYWORDS)) {
    sessions[from] = createSession();
    await sendMessage(from, `Okay, restarted. Please share your name, date, and time.`);
    return;
  }

  const extractedName = extractName(text);
  const extractedDate = extractDate(text);
  const { slot: extractedTime, invalidTime } = extractTime(text);
  const extractedReason = extractReason(text);

  if (extractedName) session.data.name = extractedName;
  if (extractedDate) session.data.date = extractedDate;
  if (extractedTime) session.data.time = extractedTime;
  if (extractedReason) session.data.reason = extractedReason;

  if (invalidTime) {
    await sendMessage(from, `Time ${invalidTime} is not available. Please choose ${formatSlots(VALID_SLOTS)}.`);
    return;
  }

  if (session.data.date === 'today' && session.data.time) {
    const availableToday = getAvailableSlotsForDate('today');
    if (!availableToday.includes(session.data.time)) {
      session.data.time = null;
      if (availableToday.length === 0) {
        session.data.date = null;
        await sendMessage(from, `No safe slots left for today. Please choose another day.`);
      } else {
        await sendMessage(from, `For today, available slots are: ${formatSlots(availableToday)}.`);
      }
      return;
    }
  }

  const missing = getMissingFields(session.data);
  if (missing.length > 0) {
    await askForMissingDetails(from, session);
    return;
  }

  const appointmentData = {
    name: session.data.name,
    phone: from,
    date: session.data.date,
    time: session.data.time,
    reason: session.data.reason,
    bookedAt: new Date().toLocaleString(),
  };

  try {
    await saveAppointment(appointmentData);
    await sendMessage(
      from,
      `Booked successfully. Name: ${appointmentData.name}. Date: ${appointmentData.date}. Time: ${appointmentData.time}. Doctor: ${DOCTOR_INFO.name}.`
    );
  } catch (error) {
    await sendMessage(from, `Booking saved in chat, but sheet save failed. Please try once again.`);
    console.error('Booking save error:', error.message);
  }

  delete sessions[from];
};

const handleMessage = async (from, text) => {
  const incomingText = (text || '').trim();
  if (!incomingText) return;

  const input = normalize(incomingText);
  const isBookingIntent = containsAny(input, BOOKING_KEYWORDS);

  if (sessions[from] || isBookingIntent) {
    await handleBookingMessage(from, incomingText);
    return;
  }

  await sendGeneralReply(from, incomingText);
};

module.exports = { handleMessage };