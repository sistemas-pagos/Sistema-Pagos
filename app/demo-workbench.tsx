'use client';

import { useMemo, useState } from 'react';
import { SYNTHETIC_BAC_RECEIPTS } from '@/src/demo/data';
import { detectAndParseReceipt } from '@/src/parsers';

type Scenario = 'valid' | 'missingHome' | 'amountMismatch' | 'duplicate' | 'editedConflict';

const SCENARIOS: Array<{ id: Scenario; title: string; description: string }> = [
  { id: 'valid', title: 'Comprobante válido', description: 'BAC + E1 B4 C18 + monto L150 y referencia legibles.' },
  { id: 'missingHome', title: 'Falta vivienda', description: 'Si falta etapa, bloque o casa, pregunta los tres datos.' },
  { id: 'amountMismatch', title: 'Monto diferente', description: 'Menos o más de L150 queda en revisión humana.' },
  { id: 'duplicate', title: 'Reenvío duplicado', description: 'El mismo archivo exacto no vuelve a sumar el pago.' },
  { id: 'editedConflict', title: 'Conflicto sospechoso', description: 'Referencia repetida con datos distintos: revisión humana.' },
];

function fakeReceipt(scenario: Scenario): string {
  if (scenario === 'missingHome') return SYNTHETIC_BAC_RECEIPTS.missingHome;
  if (scenario === 'amountMismatch') return SYNTHETIC_BAC_RECEIPTS.amountMismatch;
  if (scenario === 'editedConflict') return SYNTHETIC_BAC_RECEIPTS.editedConflict;
  return SYNTHETIC_BAC_RECEIPTS.valid;
}

export function DemoWorkbench() {
  const [scenario, setScenario] = useState<Scenario>('valid');
  const extraction = useMemo(() => detectAndParseReceipt(fakeReceipt(scenario)), [scenario]);
  const baseline = useMemo(() => detectAndParseReceipt(SYNTHETIC_BAC_RECEIPTS.valid), []);

  const status = scenario === 'duplicate'
    ? 'DUPLICADO'
    : scenario === 'amountMismatch'
      ? 'EN_REVISIÓN'
      : scenario === 'editedConflict' && extraction.reference === baseline.reference
        ? 'EN_REVISIÓN'
        : extraction.home
          ? 'PENDIENTE_VERIFICACIÓN'
          : 'ESPERANDO_RESPUESTA';

  const systemMessage = scenario === 'duplicate'
    ? 'ℹ️ Este mismo comprobante ya había sido recibido.\nNo se registró un segundo pago.'
    : scenario === 'amountMismatch'
      ? `Recibimos tu comprobante por L${extraction.amount?.toFixed(2)}. La cuota esperada es L150.00, por eso quedó en revisión.`
      : scenario === 'editedConflict'
        ? 'Recibimos tu comprobante y quedó en revisión. La referencia repetida por sí sola no se considera duplicado.'
        : extraction.home
          ? `✅ Comprobante recibido\nEtapa ${extraction.home.stage} · Bloque ${extraction.home.block} · Casa ${extraction.home.house}\nL${extraction.amount?.toFixed(2)}\nEstado: pendiente de verificación.`
          : `Recibimos tu comprobante por L${extraction.amount?.toFixed(2)}, pero falta identificar completamente la vivienda.\nPor favor responde con etapa, bloque y casa.\nEjemplo: E1 B4 C18`;

  return (
    <div className="workbench">
      <section className="panel">
        <p className="eyebrow">Simulación segura</p>
        <h2>Prueba los casos clave</h2>
        <p className="lead">No se utiliza ningún comprobante real. El texto sintético pasa por el parser BAC que usa el backend.</p>
        <div className="scenario-list">
          {SCENARIOS.map((item) => (
            <button
              className={`scenario-button${scenario === item.id ? ' is-active' : ''}`}
              key={item.id}
              type="button"
              onClick={() => setScenario(item.id)}
            >
              <strong>{item.title}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="phone">
          <div className="phone__head"><div className="avatar">R</div><div><strong>Residencial Demo</strong><br /><span>Automatización de pagos</span></div></div>
          <div className="chat">
            <div className="bubble bubble--user receipt-mini"><strong>📎 comprobante-bac-demo.png</strong>BAC · L{extraction.amount?.toFixed(2)} · referencia ficticia</div>
            <div className="bubble bubble--system">{systemMessage}</div>
            {scenario === 'missingHome' && <div className="bubble bubble--user">E1 B4 C18</div>}
            {scenario === 'missingHome' && <div className="bubble bubble--system">✅ Comprobante registrado para Etapa 1, Bloque 4, Casa 18. Estado: pendiente de verificación.</div>}
          </div>
        </div>
        <div className="pipeline">
          {['Webhook', 'Archivo', 'OCR', 'BAC parser', 'E/B/C', 'Duplicados', status].map((step) => <span className="is-done" key={step}>{step}</span>)}
        </div>
        <div className="extraction">
          <div className="field"><span>Banco</span><strong>{extraction.bank}</strong></div>
          <div className="field"><span>Cuota esperada</span><strong>L150.00</strong></div>
          <div className="field"><span>Monto depósito</span><strong>L{extraction.amount?.toFixed(2)}</strong></div>
          <div className="field"><span>Referencia</span><strong>{extraction.reference}</strong></div>
          <div className="field"><span>Detalle</span><strong>{extraction.detail}</strong></div>
          <div className="field"><span>Vivienda</span><strong>{extraction.home ? `E${extraction.home.stage} B${extraction.home.block} C${extraction.home.house}` : 'No identificada'}</strong></div>
          <div className="field"><span>Estado</span><strong>{status}</strong></div>
        </div>
      </section>
    </div>
  );
}
