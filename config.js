// Réglages de connexion à Supabase (Supabase > Project Settings > API).
// Ces deux valeurs sont publiques par conception : la sécurité est assurée
// par la base (seules les adresses autorisées voient les données).
// Laisse-les vides pour ouvrir le site en mode démo avec des données fictives.
window.ADACTA_CONFIG = {
  supabaseUrl: '',        // ex. 'https://abcdefgh.supabase.co'
  supabaseAnonKey: '',    // clé « anon » ou « publishable » (sb_publishable_…)
  googleLogin: false      // true si le fournisseur Google est activé dans Supabase Auth
};
