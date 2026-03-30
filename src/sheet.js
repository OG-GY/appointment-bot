const { google } = require('googleapis');

const saveAppointment = async (data) => {
  try {
    console.log('📝 Saving appointment:', data);

    const auth = new google.auth.GoogleAuth({
      keyFile: './credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: 'Sheet1!A:F',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          data.name,
          data.phone,
          data.date,
          data.time,
          data.reason,
          data.bookedAt,
        ]],
      },
    });

    console.log('✅ Appointment saved! Updates:', response.data.updates);
    return response.data;

  } catch (error) {
    console.error('❌ Sheets error:', error.message);
    console.error('Full error:', error);
    throw error;
  }
};

module.exports = { saveAppointment };