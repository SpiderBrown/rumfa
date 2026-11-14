import { Injectable, signal } from '@angular/core';

// English is the default; people can switch language on the first screen or in Help.
// Hausa strings should be reviewed by a native speaker before release.
const DICT: Record<string, Record<string, string>> = {
  en: {},
  ha: {
    'Sign in': 'Shiga', 'Phone number': 'Lambar waya', 'Send code': 'Aika lamba', 'Enter the code we sent by SMS': 'Shigar da lambar da muka aiko ta SMS',
    'Create a 4-digit PIN': 'Ƙirƙiri PIN mai lamba 4', 'Enter your PIN': 'Shigar da PIN ɗinka', 'Continue': 'Ci gaba',
    'Today': 'Yau', 'Check in': 'Shiga rumfa', 'Checklist': 'Jerin abubuwa', 'Report a problem': 'Bayar da rahoton matsala',
    'SOS': 'Gaggawa', 'Quick count': 'Ƙidaya cikin sauri', 'Submit result (EC8A)': 'Aika sakamako (EC8A)',
    'Ask my coordinator to call me': 'A ce mai kula ya kira ni', 'Messages': 'Saƙonni', 'Help': 'Taimako',
    'Waiting to send': 'Ana jira a aika', 'Sent': 'An aika', 'Send by SMS': 'Aika ta SMS', 'No internet': 'Babu intanet',
    'Take photo of signed sheet': 'Ɗauki hoton takardar da aka sa hannu', 'Check and submit': 'Duba ka aika', 'Submit': 'Aika',
    'Next': 'Gaba', 'Back': 'Baya', 'Yes': 'Eh', 'No': "A'a", 'Cancel': 'Soke', 'Save': 'Ajiye',
    'Your coordinator will call you': 'Mai kula zai kira ka', 'Callback requests': 'Buƙatun kira', 'Call': 'Kira',
    'My team': 'Tawagata', 'Add authority contact': 'Ƙara lambar hukuma', 'Language': 'Harshe',
    'Registered voters': 'Masu rajista', 'Accredited voters': 'Waɗanda aka tantance', 'Rejected ballots': 'Ƙuri’un da aka ƙi',
    'Total valid votes': 'Jimillar ƙuri’u masu inganci', 'Votes': "Ƙuri'u",
  },
};

export const LANGUAGES = [{ code: 'en', name: 'English' }, { code: 'ha', name: 'Hausa' }];

@Injectable({ providedIn: 'root' })
export class I18n {
  readonly lang = signal<string>(localStorage.getItem('rumfa.lang') ?? 'en');
  set(code: string) { this.lang.set(code); localStorage.setItem('rumfa.lang', code); }
  t = (s: string): string => DICT[this.lang()]?.[s] ?? s;
}
