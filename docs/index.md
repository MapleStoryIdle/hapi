---
layout: home
title: SHAPI Documentation
---

<script setup>
import { onMounted } from 'vue'
import { withBase } from 'vitepress'

onMounted(() => {
  window.location.replace(withBase('/guide/quick-start'))
})
</script>
