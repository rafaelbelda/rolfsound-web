/* ============================================================
   ROLFSOUND V2 — Camada de dados (fonte única da UI)
   render.js constrói o Acervo e a fila a partir deste objeto,
   e os demais módulos (acervo.js, busca, playlists, remixer)
   leem tudo do DOM renderizado. Para integrar com o backend,
   preencha window.RolfsoundData ANTES de render.js rodar
   (ex.: um script entre data.js e render.js, ou gerar este
   arquivo no servidor).

   Formato de faixa:
   {
     title:  'Coordinate Drift',
     artist: 'Rolf',
     album:  'Lattice',            // opcional
     year:   '2023',               // opcional
     coord:  'C04·R08',            // coordenada no cofre (id único)
     added:  1750593600000,        // epoch ms
     bpm:    118,
     key:    'A min',
     fmt:    'vinil',              // 'vinil' | 'cd' | 'digital'
     state:  'master',             // 'master' | 'edit' | 'rip'
     fav:    false,
     tags:   ['ambient'],
     dur:    228,                  // segundos
     cover:  'linear-gradient(150deg,#c8693c,#5a2f1a 56%,#141416)' // background CSS
   }
   ============================================================ */
window.RolfsoundData = {
  tracks: [],     // faixas do cofre
  queue: [],      // coords das faixas na fila "A seguir", em ordem
  playlists: [],  // { id: 'p1', name: 'Nome', coords: ['C04·R08', …] }
};
