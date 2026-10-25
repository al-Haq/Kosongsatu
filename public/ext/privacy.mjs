// Personal identity numbers on documents. A MyKad or passport number belongs
// to a person (personal data under the PDPA), so on anything that leaves the
// workspace (the paper, the PDF, the client link) only its last 4 characters
// show: "******-**-5678". The full number stays in the client record, where
// the owner edits it, and in what is sent to LHDN (MyInvois needs it).
// A business registration number (SSM, ROS) is public and shows in full.
const MYKAD = /^\d{6}-\d{2}-\d{4}$/;

// Whether the client's registration / ID number identifies a person.
export function personalId(c = {}) {
  if (c.kind === "individual") return true;
  if (["NRIC", "PASSPORT", "ARMY"].includes(c.tax_id_type)) return true;
  // Clients saved before the type existed: a hyphenated MyKad is unmistakable.
  return !c.kind && MYKAD.test(String(c.brn || "").trim());
}

// Keeps the last `keep` letters or digits; every other letter or digit becomes
// "*"; hyphens and spaces stay so the shape is still recognisable.
export function maskId(value, keep = 4) {
  const s = String(value || "").trim();
  if (!s) return "";
  const chars = [...s];
  let left = chars.filter((ch) => /[0-9A-Za-z]/.test(ch)).length - keep;
  return chars
    .map((ch) => {
      if (!/[0-9A-Za-z]/.test(ch)) return ch;
      return left-- > 0 ? "*" : ch;
    })
    .join("");
}

// The registration / ID number as it may appear on a document.
export const documentId = (c = {}) =>
  personalId(c) ? maskId(c.brn) : String(c.brn || "");
