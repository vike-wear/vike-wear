import { useState } from 'react'

export default function ProductImage({ src, alt, className = '', imgClassName = '', sizes }) {
  const [status, setStatus] = useState('loading')

  return (
    <div className={`relative overflow-hidden bg-[#141416] ${className}`}>
      {status === 'loading' && (
        <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-[#1c1c20] via-[#141416] to-[#0d0d0f]" />
      )}

      {status !== 'error' && src && (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          sizes={sizes}
          onLoad={() => setStatus('ok')}
          onError={() => setStatus('error')}
          className={`h-full w-full object-cover transition-all duration-700 ${
            status === 'ok' ? 'scale-100 opacity-100' : 'scale-105 opacity-0'
          } ${imgClassName}`}
        />
      )}

      {status === 'error' && (
        <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-[#1c1c20] to-[#0d0d0f] px-4 text-center">
          <div>
            <div className="mx-auto mb-2 h-8 w-8 rounded-full border border-white/[0.15]" />
            <span className="font-display text-xs text-[#8a8a8a]">{alt}</span>
          </div>
        </div>
      )}
    </div>
  )
}
