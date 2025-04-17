// automation-server.js
// Express service: Instantly API v2 → HubSpot contact & engagement sync
// Env vars: HUBSPOT_TOKEN, INSTABLY_API_KEY, PORT (defaults to 3000)

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
app.use(bodyParser.json());

// Env validation
const HUBSPOT_TOKEN    = process.env.HUBSPOT_TOKEN;
const INSTABLY_API_KEY = process.env.INSTABLY_API_KEY;
if (!HUBSPOT_TOKEN || !INSTABLY_API_KEY) {
  console.error('Error: Missing HUBSPOT_TOKEN or INSTABLY_API_KEY');
  process.exit(1);
}

// HubSpot client
const hubspot = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
});

// Instantly V2 client
const instantlyClient = axios.create({
  baseURL: 'https://api.instant.ly/v2',
  headers: { Authorization: `Bearer ${INSTABLY_API_KEY}` }
});

const VALID_EVENTS = [
  'reply_received',
  'lead_interested',
  'lead_meeting_booked'
];

app.post('/webhook/instantly', async (req, res) => {
  const event = req.body.event_type;
  const data  = req.body.data || {};

  if (!VALID_EVENTS.includes(event)) return res.sendStatus(204);
  if (event === 'reply_received') {
    const txt = (data.reply_text_snippet||'').toLowerCase();
    if (!/yes|interested|schedule|sure/.test(txt)) return res.sendStatus(204);
  }

  try {
    // build filters
    const filters = [];
    if (data.email) filters.push({ propertyName:'email', operator:'EQ', value:data.email });
    if (data.phone) filters.push({ propertyName:'phone', operator:'EQ', value:data.phone });
    if (data.customFields?.alternate_email)
      filters.push({ propertyName:'alternate_email', operator:'EQ', value:data.customFields.alternate_email });

    // 1️⃣ search contact
    const searchRes = await hubspot.post('/crm/v3/objects/contacts/search', {
      filterGroups:[{ filters }],
      properties:['email','phone','firstname','lastname']
    });

    let contactId;
    if (searchRes.data.total > 0) {
      contactId = searchRes.data.results[0].id;
    } else {
      // 2️⃣ create
      const props = {
        email: data.email,
        phone: data.phone,
        firstname: data.first_name||data.firstName,
        lastname: data.last_name||data.lastName,
        company: data.company,
        website: data.website,
        linkedin: data.linkedin_url||data.linkedin,
        hs_lead_status: event==='lead_meeting_booked' ? 'Meeting scheduled':'Interested',
        hs_marketing_contact_status: 'NON_MARKETING',
        ...data.customFields
      };
      const createRes = await hubspot.post('/crm/v3/objects/contacts',{properties:props});
      contactId = createRes.data.id;
    }

    // 3️⃣ log inbound email
    await hubspot.post('/crm/v3/objects/engagements',{properties:{
      engagement_type:'EMAIL',
      subject: data.subject||'Incoming from Instantly',
      body:    data.reply_text_html||data.reply_text_snippet,
      direction:'IN'
    },associations:[{to:{id:contactId,type:'contact'}}]});

    // 4️⃣ log original outbound
    if (data.original_email_id) {
      const orig = await instantlyClient.get(`/emails/${data.original_email_id}`);
      await hubspot.post('/crm/v3/objects/engagements',{properties:{
        engagement_type:'EMAIL',
        subject: orig.data.subject,
        body:    orig.data.body_html,
        direction:'OUT'
      },associations:[{to:{id:contactId,type:'contact'}}]});
    }

    // 5️⃣ log meeting if booked
    if (event==='lead_meeting_booked') {
      await hubspot.post('/crm/v3/objects/engagements',{properties:{
        engagement_type:'MEETING',
        subject: 'Meeting booked via Instantly',
        body:    `Scheduled at ${data.meeting_time}`
      },associations:[{to:{id:contactId,type:'contact'}}]});
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Instantly webhook error:', err.response?.data||err.message);
    res.sendStatus(500);
  }
});

// start server
const PORT = process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Listening on ${PORT}`));
