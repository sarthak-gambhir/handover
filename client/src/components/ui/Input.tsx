import type { InputHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import './Input.scss';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  label?: string;
}

export function Input({ mono = false, label, id, className, ...rest }: InputProps) {
  const input = (
    <input className={cx('input', mono && 'input_mono', className)} id={id} {...rest} />
  );
  if (!label) return input;
  return (
    <label className="input_field" htmlFor={id}>
      <span className="input_label">{label}</span>
      {input}
    </label>
  );
}
