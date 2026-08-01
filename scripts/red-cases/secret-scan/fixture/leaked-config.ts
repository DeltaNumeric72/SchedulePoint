/**
 * RED CASE — secret scan.
 *
 * Credential-shaped strings of several kinds. This directory is excluded from
 * the repository-wide scan (see EXCLUDED in scripts/gates/secret-scan.mjs), so
 * the red case runs the scanner against it explicitly with --no-exclude: the
 * content is still checked, by the run that needs it to match.
 *
 * None of these is a real credential. AKIAIOSFODNN7EXAMPLE is AWS's own
 * published documentation example.
 */
export const config = {
  awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  githubToken: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  stripeKey: 'sk_live_abcdefghijklmnop123456',
  databaseUrl: 'postgres://sp_app:Zq7Kf1xRb92Tt40@db.internal:5432/sp',
  clientSecret: 'Rb92-Tt40-Zq7K-f1xQ',
};
