<template>
  <!-- KixDNS 的标志「块面 K」：一根竖条加一个分开的「<」。竖条跟着文字色，「<」是品牌色，深色模式两个变量自己换；
       不套底色方块。视框裁到图形本身，和旁边的字一起排时不留空边。public/favicon.svg 是同一个图形
       The KixDNS mark, the block K: a stem and a detached 「<」. The stem follows the text colour and the 「<」 takes the accent, both
       switching by themselves in dark mode; no tile behind it. The view box is cropped to the mark so it sets beside the name without
       an empty margin. public/favicon.svg draws the same shape -->
  <svg class="brand-mark" viewBox="10.75 11 42 42" aria-hidden="true" focusable="false">
    <rect x="13" y="13" width="11" height="38" rx="3" fill="currentColor" />
    <path class="brand-mark__chevron" d="M50.5 13H38.4L27.6 30.2Q26.5 32 27.6 33.8L38.4 51H50.5L39 32Z" />
  </svg>
</template>
