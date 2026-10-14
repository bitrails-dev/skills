/**
 * @file notify.mjs
 * @description Windows system (toast) notification command builder shared by hooks and the broker.
 */

/**
 * Builds PowerShell args that raise a native Windows toast (Action Center, default chime).
 * Text is passed via single-quoted literals; the script is -EncodedCommand so no shell quoting applies.
 *
 * @param {string} title
 * @param {string} body
 * @returns {string[]} Args for powershell.exe
 */
export function toastArgs(title, body) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const ps = `
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  $x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent('ToastText02')
  $t = $x.GetElementsByTagName('text')
  $t.Item(0).AppendChild($x.CreateTextNode(${q(title)})) | Out-Null
  $t.Item(1).AppendChild($x.CreateTextNode(${q(body)})) | Out-Null
  $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))
} catch {}
`;
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")];
}
