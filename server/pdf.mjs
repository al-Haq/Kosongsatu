import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { currency, taxSummary } from "./domain.mjs";
const regular = fileURLToPath(
  new URL("../public/assets/fonts/DejaVuSans.ttf", import.meta.url),
);
const bold = fileURLToPath(
  new URL("../public/assets/fonts/DejaVuSans-Bold.ttf", import.meta.url),
);
const logo = fileURLToPath(
  new URL("../public/assets/nawlogic-logo.png", import.meta.url),
);
export function renderPdf(invoice, payment = null) {
  return new Promise((resolve, reject) => {
    const documentLabel =
      {
        invoice: "Invoice",
        quote: "Quotation",
        credit: "Credit note",
        debit: "Debit note",
        refund: "Refund note",
      }[invoice.kind] || "Document";
    const pdf = new PDFDocument({
      size: "A4",
      margin: 42,
      bufferPages: true,
      info: {
        Title: payment
          ? "Nawlogic payment receipt"
          : `${documentLabel} ${invoice.number || "DRAFT"}`,
        Author: invoice.business.company,
      },
    });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    pdf.registerFont("Body", regular);
    pdf.registerFont("Bold", bold);
    const ink = "#0F172A",
      teal = "#087F7E",
      muted = "#64748B";
    let y = 42;
    const line = (
      value,
      x,
      yy,
      size = 10,
      font = "Body",
      color = ink,
      width = 510,
    ) => {
      pdf
        .font(font)
        .fontSize(size)
        .fillColor(color)
        .text(String(value || ""), x, yy, { width, lineGap: 3 });
      return pdf.y;
    };
    const rule = (yy) =>
      pdf
        .strokeColor("#E2E8F0")
        .lineWidth(0.7)
        .moveTo(42, yy)
        .lineTo(553, yy)
        .stroke();
    const newPage = () => {
      pdf.addPage();
      y = 46;
      line(`${invoice.number || "DRAFT"} / continued`, 42, y, 10, "Bold");
      y += 35;
    };
    const room = (h) => {
      if (y + h > 755) newPage();
    };
    pdf.image(logo, 37, 32, { width: 165 });
    line(
      payment ? "PAYMENT RECEIPT" : documentLabel.toUpperCase(),
      337,
      49,
      17,
      "Bold",
      ink,
      216,
    );
    line(
      payment
        ? `Receipt ${payment.number || payment.id.slice(0, 8).toUpperCase()}`
        : invoice.number || "DRAFT - NOT ISSUED",
      337,
      79,
      10,
      "Body",
      muted,
      216,
    );
    y = 114;
    line(invoice.business.company, 42, y, 12, "Bold");
    y = pdf.y + 9;
    const company = [
      invoice.business.registration
        ? `Registration: ${invoice.business.registration}`
        : "",
      [
        invoice.business.tin ? `TIN: ${invoice.business.tin}` : "",
        invoice.business.sstNumber ? `SST No: ${invoice.business.sstNumber}` : "",
      ]
        .filter(Boolean)
        .join("  |  "),
      invoice.business.address,
      invoice.business.email,
      invoice.business.phone,
    ]
      .filter(Boolean)
      .join("\n");
    if (company) {
      line(company, 42, y, 9, "Body", muted, 320);
      y = pdf.y + 15;
    } else y += 10;
    rule(y);
    y += 19;
    line("BILL TO", 42, y, 9, "Bold", muted);
    line(
      payment ? "PAYMENT DETAILS" : "DOCUMENT DETAILS",
      337,
      y,
      9,
      "Bold",
      muted,
      216,
    );
    y += 19;
    const clientEnd = line(
      [
        invoice.client.name,
        invoice.client.contact,
        invoice.client.address,
        invoice.client.email,
        [
          invoice.client.brn ? `Reg/IC: ${invoice.client.brn}` : "",
          invoice.client.tin ? `TIN: ${invoice.client.tin}` : "",
          invoice.client.sst_number ? `SST: ${invoice.client.sst_number}` : "",
        ]
          .filter(Boolean)
          .join("  |  "),
      ]
        .filter(Boolean)
        .join("\n"),
      42,
      y,
      10,
      "Body",
      ink,
      275,
    );
    const details = payment
      ? `${payment.receiptMode ? "Receipt" : "Invoice"}: ${invoice.number}\nReceived: ${payment.paid_date}\nMethod: ${payment.method}\nReference: ${payment.reference}`
      : `Issued: ${invoice.issue_date}\n${invoice.kind === "quote" ? "Valid until" : "Due"}: ${invoice.due_date}\nCurrency: MYR\nStatus: ${invoice.status}`;
    const detailEnd = line(details, 337, y, 9, "Body", muted, 216);
    y = Math.max(clientEnd, detailEnd) + 26;
    if (invoice.business.demo) {
      line(
        "DEMO DOCUMENT - No real transaction is represented.",
        42,
        y,
        10,
        "Bold",
        "#9A4600",
      );
      y = pdf.y + 17;
    }
    if (payment) {
      room(120);
      pdf.roundedRect(42, y, 511, 85, 8).fill("#E8F8F6");
      line("PAYMENT RECEIVED", 59, y + 15, 9, "Bold", teal);
      line(currency(payment.amount), 59, y + 37, 26, "Bold", teal);
      y += 111;
      line("This receipt acknowledges the recorded payment above.", 42, y, 10);
      y = pdf.y + 18;
      line(
        payment.receiptMode
          ? `Allocated: ${currency(invoice.paid)} | Unallocated: ${currency(invoice.balance)} | Refunded: ${currency(payment.refunded || 0)}`
          : `Invoice total: ${currency(invoice.total)} | Current balance: ${currency(invoice.balance)}`,
        42,
        y,
        10,
      );
      y = pdf.y + 20;
    } else {
      const tableHead = () => {
        pdf.rect(42, y, 511, 27).fill("#F4F7FA");
        line("DESCRIPTION", 52, y + 8, 9, "Bold", muted, 272);
        line("QTY", 333, y + 8, 9, "Bold", muted, 50);
        line("RATE (RM)", 389, y + 8, 9, "Bold", muted, 78);
        line("AMOUNT", 477, y + 8, 9, "Bold", muted, 78);
        y += 35;
      };
      room(90);
      tableHead();
      for (const item of invoice.items) {
        pdf.font("Body").fontSize(10);
        const description = item.tax_rate
          ? `${item.description}\nSST ${item.tax_rate}%`
          : item.description;
        const height = Math.max(
          30,
          pdf.heightOfString(description, { width: 269 }) + 17,
        );
        if (y + height > 735) {
          newPage();
          tableHead();
        }
        line(description, 52, y, 10, "Body", ink, 269);
        line(item.quantity, 333, y, 9, "Body", ink, 45);
        line((item.rate / 100).toFixed(2), 389, y, 9, "Body", ink, 78);
        line((item.amount / 100).toFixed(2), 477, y, 9, "Body", ink, 78);
        y += height;
        rule(y - 6);
      }
      room(215);
      y += 10;
      for (const [label, value] of [
        ["Subtotal", invoice.subtotal],
        ["Discount", invoice.discount],
        ...taxSummary(invoice.items).map((t) => [`SST ${t.rate}%`, t.tax]),
        [
          invoice.kind === "invoice" ? "Original total" : "Total",
          invoice.total,
        ],
        ...(invoice.credit ? [["Credit notes", -invoice.credit]] : []),
        ...(invoice.debit ? [["Debit notes", invoice.debit]] : []),
        ...(invoice.credit || invoice.debit
          ? [["Adjusted total", invoice.adjusted_total]]
          : []),
        ...(invoice.kind === "invoice"
          ? [
              ["Paid", invoice.paid],
              ["Balance due", invoice.balance],
            ]
          : []),
      ]) {
        const strong = label === "Total" || label === "Balance due";
        line(
          label,
          330,
          y,
          strong ? 11 : 10,
          strong ? "Bold" : "Body",
          strong ? ink : muted,
          110,
        );
        line(
          currency(value),
          449,
          y,
          strong ? 11 : 10,
          strong ? "Bold" : "Body",
          strong ? teal : ink,
          104,
        );
        y += 24;
      }
    }
    for (const [heading, value] of [
      [
        "Adjustments",
        (invoice.adjustments || [])
          .map(
            (a) =>
              `${a.number} / ${a.kind}: ${currency(a.amount)} / ${a.reason}`,
          )
          .join("\n"),
      ],
      [
        "Payment information",
        payment
          ? ""
          : invoice.kind === "invoice"
            ? [
                invoice.business.bankName,
                invoice.business.bankHolder,
                invoice.business.bankAccount,
                invoice.business.bankAccount
                  ? `Reference: ${invoice.number || "DRAFT"}`
                  : "Bank details are not configured. Contact Nawlogic before paying.",
              ]
                .filter(Boolean)
                .join("\n")
            : "",
      ],
      ["Terms", invoice.terms],
      ["Notes", invoice.notes],
    ]) {
      if (!value) continue;
      room(55);
      y += 13;
      line(heading, 42, y, 10, "Bold");
      y += 19;
      // Wrap long audit/note blocks explicitly so every page retains its footer margin.
      pdf.font("Body").fontSize(9);
      const lines = [];
      for (const paragraph of String(value).split("\n")) {
        let current = "";
        for (const word of paragraph.split(/\s+/)) {
          const candidate = current ? current + " " + word : word;
          if (pdf.widthOfString(candidate) <= 511) {
            current = candidate;
            continue;
          }
          if (current) lines.push(current);
          current = "";
          for (const char of word) {
            if (pdf.widthOfString(current + char) > 511) {
              lines.push(current);
              current = "";
            }
            current += char;
          }
        }
        lines.push(current);
      }
      for (const text of lines) {
        room(18);
        line(text || " ", 42, y, 9, "Body", muted);
        y += 16;
      }
      y += 8;
    }
    const pages = pdf.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      pdf.switchToPage(i);
      rule(778);
      line(
        `Nawlogic | ${payment ? "Payment receipt" : "Business document"} | Not a validated MyInvois e-Invoice`,
        42,
        788,
        7,
        "Body",
        muted,
        450,
      );
      line(`${i + 1} / ${pages.count}`, 511, 788, 7, "Body", muted, 42);
    }
    pdf.end();
  });
}

export function renderReceiptPdf(receipt) {
  const invoice = {
    kind: "invoice",
    number: receipt.number,
    business: receipt.business,
    client: receipt.client,
    issue_date: receipt.paid_date,
    due_date: receipt.paid_date,
    status: receipt.voided ? "Void" : "Received",
    items: [],
    total: receipt.amount,
    subtotal: receipt.amount,
    discount: 0,
    paid: receipt.allocated,
    balance: receipt.available,
    terms: "",
    notes:
      "Allocations are recorded separately from cash received. A payment allocation reversal is not a bank refund.",
  };
  return renderPdf(invoice, {
    ...receipt,
    receiptMode: true,
    refunded: receipt.refunded,
  });
}
export function renderAdjustmentPdf(invoice, note) {
  const name = {
    credit: "Credit note",
    debit: "Debit note",
    refund: "Refund note",
  }[note.kind];
  return renderPdf({
    ...invoice,
    kind: note.kind,
    number: note.number,
    issue_date: note.issue_date || note.paid_date,
    due_date: note.issue_date || note.paid_date,
    status: "Issued",
    items: [
      {
        description: note.reason,
        quantity: 1,
        rate: note.amount,
        amount: note.amount,
      },
    ],
    subtotal: note.amount,
    discount: 0,
    total: note.amount,
    adjusted_total: note.amount,
    credit: 0,
    debit: 0,
    adjustments: [],
    paid: 0,
    balance: 0,
    terms: "",
    notes: `${name} referencing ${invoice.number}.\n${note.reference ? "Transaction reference: " + note.reference : ""}`,
  });
}
