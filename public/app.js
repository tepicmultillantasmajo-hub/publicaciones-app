'use strict';
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const csrf = () => ($('meta[name="csrf"]') || {}).content || '';

  // Menú en celular
  const botonMenu = $('[data-alternar-menu]');
  if (botonMenu) botonMenu.addEventListener('click', () => $('#nav').classList.toggle('abierto'));

  // Confirmaciones y botones ocupados
  $$('form[data-confirmar]').forEach((f) => f.addEventListener('submit', (e) => {
    if (!confirm(f.dataset.confirmar)) e.preventDefault();
  }));
  $$('form[data-ocupado]').forEach((f) => f.addEventListener('submit', () => {
    const b = $('button[type="submit"]', f);
    if (b) { b.disabled = true; b.textContent = f.dataset.ocupado; }
  }));

  // Copiar credenciales
  $$('[data-copiar]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copiar);
      const t = b.textContent; b.textContent = 'Copiado ✓';
      setTimeout(() => { b.textContent = t; }, 2000);
    } catch { alert('No se pudo copiar; selecciona el texto manualmente.'); }
  }));

  // Filtros que se aplican solos
  $$('form[data-auto-enviar] select').forEach((s) => s.addEventListener('change', () => s.form.submit()));

  // Recarga automática mientras algo se está publicando
  const recarga = $('[data-auto-recargar]');
  if (recarga) setTimeout(() => location.reload(), Number(recarga.dataset.autoRecargar) * 1000);

  // Alta de usuarios: páginas y aprobación solo aplican a proveedores
  const selRol = $('select[data-rol]');
  const soloProv = $('[data-solo-proveedor]');
  if (selRol && soloProv) {
    const act = () => { soloProv.hidden = selRol.value !== 'proveedor'; };
    selRol.addEventListener('change', act); act();
  }

  // ---------- Formulario de publicación ----------
  const form = $('#form-publicar');
  if (!form) return;
  const d = form.dataset;
  const archivo = $('#archivo');
  const zona = $('#zona-archivo');
  const previa = $('#previa');
  const datos = $('#datos-archivo');
  const avisoArchivo = $('#aviso-archivo');
  const textoEl = $('#texto');
  const contador = $('#contador');
  const progreso = $('#progreso');
  const barra = $('#barra');
  const estado = $('#estado-progreso');
  const errorEl = $('#error-publicar');
  const boton = $('#boton-publicar');
  const textoBoton = boton.textContent;
  let problemaArchivo = null;
  let urlPrevia = null;

  const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
  function mostrarAviso(msg) {
    problemaArchivo = msg;
    avisoArchivo.textContent = msg || '';
    avisoArchivo.hidden = !msg;
    zona.classList.toggle('con-error', !!msg);
  }
  function mostrarError(msg) { errorEl.textContent = msg; errorEl.hidden = !msg; }

  textoEl.addEventListener('input', () => {
    contador.textContent = textoEl.value.length;
    contador.parentElement.classList.toggle('excedido', textoEl.value.length > Number(d.maxTexto));
  });

  archivo.addEventListener('change', () => {
    mostrarError('');
    mostrarAviso(null);
    if (urlPrevia) URL.revokeObjectURL(urlPrevia);
    previa.innerHTML = '';
    datos.textContent = '';
    const f = archivo.files[0];
    zona.classList.toggle('con-archivo', !!f);
    if (!f) { previa.innerHTML = '<p class="sutil">Aquí verás tu archivo.</p>'; return; }

    const esImagen = f.type === 'image/jpeg';
    const esVideo = f.type === 'video/mp4' || f.type === 'video/quicktime';
    if (!esImagen && !esVideo) return mostrarAviso('Formato no permitido. Usa imagen JPG o video MP4/MOV.');
    const limite = (esVideo ? Number(d.maxVideo) : Number(d.maxImagen)) * 1048576;
    if (f.size > limite) return mostrarAviso(`El archivo pesa ${mb(f.size)}; el máximo es ${mb(limite)}.`);

    urlPrevia = URL.createObjectURL(f);
    datos.textContent = `${f.name} · ${mb(f.size)}`;
    if (esImagen) {
      const img = new Image();
      img.onload = () => {
        const r = img.naturalWidth / img.naturalHeight;
        datos.textContent += ` · ${img.naturalWidth}×${img.naturalHeight}`;
        if (r < 0.8 || r > 1.91) mostrarAviso('Instagram solo acepta imágenes entre 4:5 vertical (1080×1350) y 1.91:1 horizontal. Recórtala antes de subirla.');
      };
      img.src = urlPrevia;
      img.alt = 'Vista previa';
      previa.appendChild(img);
    } else {
      const v = document.createElement('video');
      v.src = urlPrevia; v.controls = true; v.muted = true; v.playsInline = true; v.preload = 'metadata';
      v.onloadedmetadata = () => {
        const r = v.videoWidth / v.videoHeight;
        datos.textContent += ` · ${v.videoWidth}×${v.videoHeight} · ${v.duration.toFixed(1)} s`;
        if (v.duration < Number(d.minSeg) || v.duration > Number(d.maxSeg)) {
          mostrarAviso(`El video dura ${v.duration.toFixed(1)} s; debe durar entre ${d.minSeg} y ${d.maxSeg} segundos.`);
        } else if (r < 0.5 || r > 0.6) {
          mostrarAviso('El video debe ser vertical 9:16 (por ejemplo 1080×1920).');
        }
      };
      v.onerror = () => { datos.textContent += ' · (sin vista previa en este navegador; se revisará al subirlo)'; };
      previa.appendChild(v);
    }
  });

  function subirArchivo(f) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', d.subir);
      xhr.setRequestHeader('Content-Type', f.type);
      xhr.setRequestHeader('X-CSRF-Token', csrf());
      xhr.setRequestHeader('X-Nombre-Archivo', encodeURIComponent(f.name));
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        barra.style.width = pct + '%';
        estado.textContent = `Subiendo archivo… ${pct}% (${mb(e.loaded)} de ${mb(e.total)})`;
      };
      xhr.onload = () => {
        let r = {};
        try { r = JSON.parse(xhr.responseText); } catch { /* respuesta no JSON */ }
        if (xhr.status === 200 && r.id) resolve(r);
        else reject(new Error(r.error || `Error al subir (código ${xhr.status}).`));
      };
      xhr.onerror = () => reject(new Error('Se perdió la conexión durante la subida. Revisa tu internet e inténtalo de nuevo.'));
      xhr.send(f);
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mostrarError('');
    const f = archivo.files[0];
    if (!f) return mostrarError('Elige una imagen o un video.');
    if (problemaArchivo) return mostrarError(problemaArchivo);
    if (textoEl.value.length > Number(d.maxTexto)) return mostrarError(`El texto supera los ${d.maxTexto} caracteres.`);
    const pagina = $('input[name="pagina_id"]:checked', form);
    if (!pagina) return mostrarError('Elige una página.');

    boton.disabled = true;
    boton.textContent = 'Enviando…';
    progreso.hidden = false;
    barra.style.width = '0%';
    barra.classList.remove('indeterminada');
    try {
      const subida = await subirArchivo(f);
      barra.style.width = '100%';
      barra.classList.add('indeterminada');
      estado.textContent = subida.tipo === 'video'
        ? 'Procesando el video… puede tardar un poco, no cierres esta pantalla.'
        : 'Procesando la imagen…';
      const cuerpo = new URLSearchParams({ subida_id: subida.id, pagina_id: pagina.value, texto: textoEl.value, _csrf: csrf() });
      const resp = await fetch(d.publicar, {
        method: 'POST', body: cuerpo, headers: { Accept: 'application/json' }, credentials: 'same-origin',
      });
      const r = await resp.json().catch(() => ({}));
      if (!resp.ok || !r.ok) throw new Error(r.error || `Error al publicar (código ${resp.status}).`);
      estado.textContent = 'Listo ✓';
      location.href = r.redirigir;
    } catch (err) {
      mostrarError(err.message);
      progreso.hidden = true;
      boton.disabled = false;
      boton.textContent = textoBoton;
    }
  });
})();
