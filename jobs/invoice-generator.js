/**
 * Generator invoice bulanan.
 *
 * Dependensi: npm i dayjs
 *
 * Dijalankan tiap hari. Menerbitkan invoice H-<LEAD_DAYS> sebelum jatuh tempo
 * supaya pelanggan punya waktu bayar sebelum kena isolir.
 *
 * Aman dijalankan berkali-kali dalam sehari: unique index
 * (service_id, period) yang menjamin tidak ada invoice dobel.
 */

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { Service, Invoice, Notification } = require('../models');
const { nextInvoiceNumber, allocateUniqueCode } = require('../lib/counter');

const TZ = process.env.TZ_APP || 'Asia/Jakarta';
const LEAD_DAYS = Number(process.env.INVOICE_LEAD_DAYS || 7);
const USE_UNIQUE_CODE = process.env.USE_UNIQUE_CODE !== 'false';

/**
 * Terbitkan invoice untuk satu service.
 * Return null kalau invoice periode ini sudah ada (bukan error).
 */
async function issueInvoice(service) {
  const due = dayjs(service.next_due_date).tz(TZ);
  const period = due.format('YYYY-MM');

  // Cek murah dulu sebelum menghabiskan nomor urut
  const exists = await Invoice.exists({ service_id: service._id, period });
  if (exists) return null;

  const plan = service.plan_id;
  if (!plan) throw new Error(`Service ${service._id} tidak punya plan valid`);

  const amount = plan.price_idr;
  const tax = plan.tax_percent ? Math.round(amount * plan.tax_percent / 100) : 0;
  const uniqueCode = USE_UNIQUE_CODE ? await allocateUniqueCode() : 0;

  const number = await nextInvoiceNumber(period);

  try {
    const invoice = await Invoice.create({
      service_id:  service._id,
      customer_id: service.customer_id._id || service.customer_id,
      number,
      period,
      amount_idr:  amount,
      tax_idr:     tax,
      unique_code: uniqueCode,
      total_idr:   amount + tax + uniqueCode,
      issued_at:   new Date(),
      due_date:    due.endOf('day').toDate(),
      status:      'unpaid',
    });

    await queueInvoiceNotification(invoice, service);
    return invoice;
  } catch (err) {
    // E11000 = balapan dengan proses lain yang sudah menerbitkan invoice sama.
    // Ini kondisi normal, bukan kegagalan.
    if (err.code === 11000) return null;
    throw err;
  }
}

async function queueInvoiceNotification(invoice, service) {
  const customer = service.customer_id;
  try {
    await Notification.create({
      customer_id: customer._id || customer,
      invoice_id:  invoice._id,
      channel:     'whatsapp',
      template:    'invoice_baru',
      payload: {
        nama:     customer.name,
        nomor:    invoice.number,
        periode:  invoice.period,
        total:    invoice.total_idr,
        jatuh_tempo: dayjs(invoice.due_date).tz(TZ).format('DD MMM YYYY'),
      },
      status: 'queued',
    });
  } catch (err) {
    // Unique index (invoice_id, template) — notifikasi sudah pernah diantrikan
    if (err.code !== 11000) throw err;
  }
}

/**
 * Majukan tanggal jatuh tempo berikutnya.
 *
 * Pakai penambahan bulan kalender, bukan +30 hari, supaya tanggal tagihan
 * tidak bergeser terus (5 Jan, 4 Feb, 6 Mar, ...). due_day dibatasi 1-28
 * di schema jadi tidak ada masalah Februari.
 */
function advanceDueDate(service) {
  const plan = service.plan_id;
  const current = dayjs(service.next_due_date).tz(TZ);

  if (plan.cycle_days && plan.cycle_days !== 30) {
    return current.add(plan.cycle_days, 'day').toDate();
  }
  return current.add(1, 'month').date(service.due_day).startOf('day').toDate();
}

/**
 * Job utama. Return ringkasan untuk logging.
 */
async function run() {
  const horizon = dayjs().tz(TZ).add(LEAD_DAYS, 'day').endOf('day').toDate();

  const services = await Service.find({
    status: { $in: ['active', 'isolated'] }, // yang terisolir tetap ditagih
    next_due_date: { $lte: horizon },
  })
    .populate('plan_id')
    .populate('customer_id', 'name phone code status')
    .limit(500); // batasi per run supaya tidak menahan event loop

  const result = { checked: services.length, issued: 0, skipped: 0, failed: 0, errors: [] };

  for (const service of services) {
    try {
      if (service.customer_id?.status === 'blacklist') {
        result.skipped++;
        continue;
      }

      const invoice = await issueInvoice(service);

      if (invoice) {
        result.issued++;
      } else {
        result.skipped++;
      }

      // Majukan due date apapun hasilnya — kalau invoice sudah ada, artinya
      // periode ini memang sudah diproses dan pointer harus tetap maju.
      service.next_due_date = advanceDueDate(service);
      await service.save();
    } catch (err) {
      result.failed++;
      result.errors.push({ service: String(service._id), message: err.message });
    }
  }

  return result;
}

module.exports = { run, issueInvoice, advanceDueDate };
