# Clients

**Records → Clients** holds everyone you bill: companies, people, government bodies and organisations. Only the **name** is required to save a client; everything else can be added later.

## Client type

The form starts with the type. The labels follow it, so the right details are asked for:

| Type                                                      | Name field                | Number field                            | Contact           | SST                       |
| --------------------------------------------------------- | ------------------------- | --------------------------------------- | ----------------- | ------------------------- |
| **Company or business**                                   | Company name              | Registration number (SSM)               | Contact person    | SST registration (if any) |
| **Individual**                                            | Full name                 | IC or passport number                   | —                 | —                         |
| **Government**                                            | Agency or department name | Reference number, if any                | Officer in charge | SST registration (if any) |
| **Organisation** (NGO, association, society, cooperative) | Organisation name         | Registration number (ROS / SSM), if any | Contact person    | SST registration (if any) |

The type shows as a tag in the client list and on the client's page. It also sets the e-Invoice buyer ID when you use MyInvois (Tax): an individual without a TIN is identified by MyKad or passport with LHDN's general TIN; a government body without a TIN or number uses LHDN's general TIN for government and "NA".

## Regular, member or VIP

**Relationship** marks a client as _Regular_, _Member_ or _VIP_, with an optional note of what they get (for example "10% extra discount, 2 pendrives per order").

- The badge shows in the client list and on the client's page.
- When you pick that client in a quotation or invoice, the note appears under the client field as a reminder.
- **Nothing is automatic**: the discount or gift is still yours to type on the lines. The tag only makes sure nobody forgets.

## Privacy of IC and passport numbers

A MyKad or passport number identifies a person, so it is personal data (Personal Data Protection Act 2010). On everything that leaves the workspace, the number shows **only its last 4 characters**: `******-**-5678`.

- Masked: the document preview, the PDF, the client link and the client portal.
- In full: the client record (owner and staff, for editing and checks) and what is sent to LHDN through MyInvois, which needs the whole number. The validated e-Invoice on MyInvois carries the full data; the printed copy carries the validation QR.
- Business registration numbers (SSM, ROS) are public records and show in full.
- Clients saved before the type existed are treated as a person when their number has the MyKad shape `YYMMDD-PB-####`, or when an ID type of NRIC, passport or army is set in the Tax fields.

Why the last 4 and not the first: the first six digits of a MyKad are the date of birth and the next two the place of birth, so hiding the _last_ four would still reveal those. Showing only the last four lets the client recognise the number without giving away anything else, the same way banks print card numbers.
