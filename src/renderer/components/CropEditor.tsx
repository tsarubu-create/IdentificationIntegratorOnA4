import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyzedImage, DocumentKind, EditorPreview, ManualAdjustment } from '@shared/types';
import { OFFICIAL_SIZE_MM } from '@core/standards/documentSizes';
import { mmToPx } from '@core/layout/a4';
import { resolvePlacement } from '@core/layout/placement';
import { manualQuad } from '@core/geometry/manualAdjustment';
import { quadFromCenter, quadToArray } from '@core/geometry/quad';

interface CropEditorProps {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly onClose: () => void;
  readonly onSaved: (image: AnalyzedImage) => void;
}

export function CropEditor({ id, kind, onClose, onSaved }: CropEditorProps): React.JSX.Element {
  const [preview, setPreview] = useState<EditorPreview | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [position, setPosition] = useState<ManualAdjustment>({
    centerX: 0,
    centerY: 0,
    angleDegrees: 0,
  });
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const size = OFFICIAL_SIZE_MM[kind];
  const placement = resolvePlacement(size, kind);

  useEffect(() => {
    const previousFocus = document.activeElement;
    root.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void window.api
      .loadEditor({ id, kind })
      .then((response) => {
        if (!active) return;
        if (!response.ok) {
          setError(response.message);
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([response.preview.bytes], { type: 'image/webp' }));
        setUrl(objectUrl);
        setPreview(response.preview);
        setPosition(response.preview.adjustment);
      })
      .catch(() => {
        if (active) setError('編集用画像を読み込めませんでした。閉じてから再度お試しください。');
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, kind]);

  const validation = useMemo(() => {
    if (!preview) return null;
    try {
      manualQuad(position, kind, preview.effectiveDpi, {
        width: preview.sourceWidth,
        height: preview.sourceHeight,
      });
      return null;
    } catch (failure) {
      return failure instanceof Error ? failure.message : '位置を確認してください';
    }
  }, [position, kind, preview]);

  function move(centerX: number, centerY: number): void {
    if (!preview || saving || !Number.isFinite(centerX) || !Number.isFinite(centerY)) return;
    setPosition((current) => ({
      ...current,
      centerX: Math.max(0, Math.min(preview.sourceWidth, centerX)),
      centerY: Math.max(0, Math.min(preview.sourceHeight, centerY)),
    }));
  }

  function pointer(event: React.PointerEvent<SVGSVGElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * (preview?.sourceWidth ?? 0),
      y: ((event.clientY - rect.top) / rect.height) * (preview?.sourceHeight ?? 0),
    };
  }

  async function save(): Promise<void> {
    if (!preview || validation || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await window.api.adjust({ id, kind, adjustment: position });
      if (result.ok) onSaved(result.image);
      else setError(result.message);
    } catch {
      setError('調整を反映できませんでした。もう一度お試しください。');
    } finally {
      setSaving(false);
    }
  }

  const dpi = preview?.effectiveDpi ?? 300;
  const cardSize = { width: mmToPx(size.widthMm, dpi), height: mmToPx(size.heightMm, dpi) };
  const tileSize = {
    width: mmToPx(placement.cropSizeMm.widthMm, dpi),
    height: mmToPx(placement.cropSizeMm.heightMm, dpi),
  };
  const center = { x: position.centerX, y: position.centerY };
  const angle = (position.angleDegrees * Math.PI) / 180;
  const points = (width: number, height: number): string =>
    quadToArray(quadFromCenter(center, angle, { width, height }))
      .map((p) => `${p.x},${p.y}`)
      .join(' ');
  const scale = preview
    ? Math.min(520 / preview.sourceWidth, 440 / preview.sourceHeight) * zoom
    : 1;
  const outputWidth = mmToPx(placement.sizeMm.widthMm, dpi);
  const outputHeight = mmToPx(placement.sizeMm.heightMm, dpi);

  return (
    <div className="modal__backdrop editor__backdrop">
      <div
        className="editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
        tabIndex={-1}
        ref={root}
        aria-busy={saving}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !saving) {
            event.stopPropagation();
            onClose();
          }
          if (event.key === 'Tab') {
            const controls = root.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
            );
            const first = controls?.[0];
            const last = controls?.[controls.length - 1];
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === root.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="editor__header">
          <div>
            <h2 id="editor-title">切り出し位置を調整</h2>
            <p className="editor__path">{id}</p>
          </div>
          <button type="button" className="button" disabled={saving} onClick={onClose}>
            閉じる
          </button>
        </div>
        <p className="editor__help">
          青い枠を券面に合わせてドラッグしてください。画像を押して移動することもできます。
        </p>
        {preview && url ? (
          <div className="editor__body">
            <div>
              <div className="editor__toolbar">
                <span>表示倍率</span>
                {[1, 2, 4].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="button"
                    aria-pressed={zoom === value}
                    onClick={() => setZoom(value)}
                  >
                    {value}倍
                  </button>
                ))}
              </div>
              <div className="editor__viewport">
                <svg
                  ref={canvas}
                  className="editor__canvas"
                  role="img"
                  aria-label="元画像と切り出し枠。矢印キーで移動、Shiftと矢印で10画素移動"
                  tabIndex={0}
                  width={preview.sourceWidth * scale}
                  height={preview.sourceHeight * scale}
                  viewBox={`0 0 ${preview.sourceWidth} ${preview.sourceHeight}`}
                  onPointerDown={(event) => {
                    if (saving || event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    const p = pointer(event);
                    const dx = p.x - center.x;
                    const dy = p.y - center.y;
                    const inside =
                      Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle)) <= cardSize.width / 2 &&
                      Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle)) <= cardSize.height / 2;
                    drag.current = inside ? { x: dx, y: dy } : { x: 0, y: 0 };
                    if (!inside) move(p.x, p.y);
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
                      const p = pointer(event);
                      move(p.x - drag.current.x, p.y - drag.current.y);
                    }
                  }}
                  onPointerUp={(event) => {
                    drag.current = null;
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      event.currentTarget.releasePointerCapture(event.pointerId);
                  }}
                  onPointerCancel={() => {
                    drag.current = null;
                  }}
                  onKeyDown={(event) => {
                    const step = event.shiftKey ? 10 : 1;
                    const delta = {
                      ArrowLeft: [-step, 0],
                      ArrowRight: [step, 0],
                      ArrowUp: [0, -step],
                      ArrowDown: [0, step],
                    }[event.key];
                    if (delta) {
                      event.preventDefault();
                      move(center.x + delta[0]!, center.y + delta[1]!);
                    }
                  }}
                >
                  <image href={url} width={preview.sourceWidth} height={preview.sourceHeight} />
                  <polygon
                    className="editor__tile"
                    points={points(tileSize.width, tileSize.height)}
                  />
                  <polygon
                    className="editor__card"
                    points={points(cardSize.width, cardSize.height)}
                  />
                  <circle cx={center.x} cy={center.y} r={6 / scale} className="editor__center" />
                </svg>
              </div>
              <p className="editor__legend">青枠：券面 / 点線：余白を含む出力範囲</p>
            </div>
            <aside className="editor__controls">
              <h3>出力プレビュー</h3>
              <svg
                className="editor__output"
                role="img"
                aria-label="調整後の出力プレビュー"
                viewBox={`${-outputWidth / 2} ${-outputHeight / 2} ${outputWidth} ${outputHeight}`}
              >
                <image
                  href={url}
                  width={preview.sourceWidth}
                  height={preview.sourceHeight}
                  transform={`rotate(${(placement.requiresRotation ? 90 : 0) - position.angleDegrees}) translate(${-center.x} ${-center.y})`}
                />
              </svg>
              <p>
                {kind === 'idCard' ? '身分証カード' : 'パスポート見開き'}
                <br />
                {size.widthMm.toFixed(2)} × {size.heightMm.toFixed(2)} mm
              </p>
              <label>
                中心 X（画素）
                <input
                  type="number"
                  value={Math.round(center.x)}
                  min={0}
                  max={preview.sourceWidth}
                  disabled={saving}
                  onChange={(event) => move(Number(event.target.value), center.y)}
                />
              </label>
              <label>
                中心 Y（画素）
                <input
                  type="number"
                  value={Math.round(center.y)}
                  min={0}
                  max={preview.sourceHeight}
                  disabled={saving}
                  onChange={(event) => move(center.x, Number(event.target.value))}
                />
              </label>
              <label>
                傾き {position.angleDegrees.toFixed(1)}°
                <input
                  type="range"
                  min={-90}
                  max={90}
                  step={0.5}
                  value={position.angleDegrees}
                  disabled={saving}
                  onChange={(event) =>
                    setPosition((current) => ({
                      ...current,
                      angleDegrees: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <button
                type="button"
                className="button"
                disabled={saving}
                onClick={() => setPosition((current) => ({ ...current, angleDegrees: 0 }))}
              >
                水平に戻す
              </button>
              <button
                type="button"
                className="button"
                disabled={saving}
                onClick={() => setPosition(preview.adjustment)}
              >
                開いたときの位置に戻す
              </button>
              {validation && (
                <p className="reason reason--warn" role="status">
                  {validation}
                </p>
              )}
            </aside>
          </div>
        ) : (
          !error && <p role="status">編集用画像を読み込んでいます…</p>
        )}
        {error && (
          <p className="reason reason--error" role="alert">
            {error}
          </p>
        )}
        <div className="editor__actions">
          <span>元画像は変更しません。</span>
          <button type="button" className="button" disabled={saving} onClick={onClose}>
            変更を破棄
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!preview || validation !== null || saving}
            onClick={() => void save()}
          >
            {saving ? '反映中…' : '調整を反映'}
          </button>
        </div>
      </div>
    </div>
  );
}
