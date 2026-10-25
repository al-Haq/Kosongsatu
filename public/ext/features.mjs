// Features that are built but not offered for now.
//
// Two-step sign-in (MFA) is hidden: nobody is asked to set it up (setup
// checklist, Settings > Security, My account), and the sign-in page has no
// code box. An account that already uses MFA keeps it: the code box appears
// only after the server says that account needs a code, and its owner can
// still manage or turn it off. Set to true to offer MFA again.
export const OFFER_MFA = false;
