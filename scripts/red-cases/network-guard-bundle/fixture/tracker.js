// RED CASE — network-assertion guard (built-bundle scan).
//
// A third-party host that arrived inside a dependency and exists only in the
// emitted bundle. No source scan can see this; the bundle scan must.
(function(){var e=function(n){return fetch("https://tracker.example.net/px?e="+n)};e("load")})();
