// Force layout of the site map graph, off the main thread (spec §14.5.2, RF-MAP-116). A classic worker:
// d3-force and its dependencies are loaded as they are from vendor/ (ADR-0021).
importScripts('/app/vendor/d3-dispatch.min.js', '/app/vendor/d3-quadtree.min.js', '/app/vendor/d3-timer.min.js', '/app/vendor/d3-force.min.js');

onmessage = (ev) => {
  const { nodes, links } = ev.data;
  for (const n of nodes) if (n.fixed) { n.fx = 0; n.fy = 0; }
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id((d) => d.id).distance(40).strength(0.6))
    .force('charge', d3.forceManyBody().strength(-60))
    .force('collide', d3.forceCollide(7))
    .force('center', d3.forceCenter(0, 0))
    .stop();
  const total = 300;
  for (let i = 0; i < total; i++) {
    sim.tick();
    if (i % 20 === 19 && i < total - 1) postMessage({ nodes: nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })), done: false });
  }
  postMessage({ nodes: nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })), done: true });
};
