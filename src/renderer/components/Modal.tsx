/** 理由を明示するモーダル（仕様書 §3: 入力 0 枚のときなど）。 */
interface ModalProps {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly onClose: () => void;
}

export function Modal({ title, children, onClose }: ModalProps): React.JSX.Element {
  return (
    <div className="modal__backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="modal-title">{title}</h2>
        <p className="modal__body">{children}</p>
        <div className="modal__actions">
          <button type="button" className="button button--primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
